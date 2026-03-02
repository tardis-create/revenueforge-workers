import { Hono } from 'hono'
import { Resend } from 'resend'
import { SignJWT, jwtVerify } from 'jose'
import bcrypt from 'bcryptjs'

type Bindings = {
  DB: D1Database
  CACHE?: KVNamespace
  PRODUCTS_BUCKET?: R2Bucket
  JWT_SECRET: string
  RESEND_API_KEY: string
  RESEND_FROM_EMAIL: string
  TWILIO_ACCOUNT_SID: string
  TWILIO_AUTH_TOKEN: string
  TWILIO_PHONE_NUMBER: string
  NOTIFICATION_EMAIL_TO: string
  ADMIN_WHATSAPP_NUMBER: string
}

type Variables = {
  user: any
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// D1-based rate limiting (5 attempts per 60-second window)
// Uses Unix timestamp (seconds) for window_start
const RATE_LIMIT_WINDOW_SECONDS = 60
const RATE_LIMIT_MAX_ATTEMPTS = 5

async function checkRateLimit(
  db: D1Database, 
  email: string
): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const windowExpiry = nowSeconds - RATE_LIMIT_WINDOW_SECONDS
  
  // Get current rate limit record
  const record = await db.prepare(
    'SELECT attempts, window_start FROM rate_limit WHERE email = ?'
  ).bind(email.toLowerCase()).first() as { attempts: number; window_start: number } | null
  
  // No record or window expired - start fresh
  if (!record || record.window_start < windowExpiry) {
    await db.prepare(
      'INSERT OR REPLACE INTO rate_limit (email, attempts, window_start) VALUES (?, 1, ?)'
    ).bind(email.toLowerCase(), nowSeconds).run()
    
    return { 
      allowed: true, 
      remaining: RATE_LIMIT_MAX_ATTEMPTS - 1, 
      resetIn: RATE_LIMIT_WINDOW_SECONDS * 1000 
    }
  }
  
  // Check if limit exceeded
  if (record.attempts >= RATE_LIMIT_MAX_ATTEMPTS) {
    const resetIn = ((record.window_start + RATE_LIMIT_WINDOW_SECONDS) - nowSeconds) * 1000
    return { allowed: false, remaining: 0, resetIn: Math.max(0, resetIn) }
  }
  
  // Increment attempts
  const newAttempts = record.attempts + 1
  await db.prepare(
    'UPDATE rate_limit SET attempts = ? WHERE email = ?'
  ).bind(newAttempts, email.toLowerCase()).run()
  
  const resetIn = ((record.window_start + RATE_LIMIT_WINDOW_SECONDS) - nowSeconds) * 1000
  return { 
    allowed: true, 
    remaining: RATE_LIMIT_MAX_ATTEMPTS - newAttempts, 
    resetIn: Math.max(0, resetIn) 
  }
}

// Cleanup expired rate limit entries (call periodically)
async function cleanupRateLimits(db: D1Database): Promise<void> {
  const windowExpiry = Math.floor(Date.now() / 1000) - RATE_LIMIT_WINDOW_SECONDS
  await db.prepare('DELETE FROM rate_limit WHERE window_start < ?').bind(windowExpiry).run()
}

// JWT helpers
async function createToken(payload: object, secret: string): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(new TextEncoder().encode(secret))
}

async function verifyToken(token: string, secret: string): Promise<{ valid: boolean; payload?: any; error?: string }> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret))
    return { valid: true, payload }
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : 'Invalid token' }
  }
}

// Helper to parse cookies from header
function parseCookies(cookieHeader: string | null | undefined): Record<string, string> {
  if (!cookieHeader) return {}
  const cookies: Record<string, string> = {}
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=')
    if (name) {
      cookies[name] = rest.join('=')
    }
  })
  return cookies
}

// Auth middleware
async function authMiddleware(c: any, next: () => Promise<void>) {
  const cookies = parseCookies(c.req.header('Cookie'))
  const token = cookies.token || c.req.header('Authorization')?.replace('Bearer ', '')
  
  if (!token) {
    return c.json({ error: 'Authentication required' }, 401)
  }
  
  const result = await verifyToken(token, c.env.JWT_SECRET)
  
  if (!result.valid) {
    return c.json({ error: 'Invalid or expired token' }, 401)
  }
  
  // Attach user to context
  c.set('user', result.payload)
  await next()
}

// Initialize Resend client
function getResend(env: Bindings): Resend | null {
  if (!env.RESEND_API_KEY) return null
  return new Resend(env.RESEND_API_KEY)
}

// Send email via Resend
async function sendEmail(
  env: Bindings,
  to: string,
  subject: string,
  html: string,
  text?: string
): Promise<{ success: boolean; error?: string; id?: string }> {
  const resend = getResend(env)
  if (!resend) {
    return { success: false, error: 'Resend not configured' }
  }

  try {
    const result = await resend.emails.send({
      from: env.RESEND_FROM_EMAIL || 'RevenueForge <notifications@revenueforge.com>',
      to,
      subject,
      html,
      text,
    })
    
    if (result.error) {
      return { success: false, error: result.error.message }
    }
    
    return { success: true, id: result.data?.id }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

// Send WhatsApp message via Twilio
async function sendWhatsApp(
  env: Bindings,
  to: string,
  message: string
): Promise<{ success: boolean; error?: string; sid?: string }> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    console.log('WhatsApp: Twilio not configured, would send:', { to, message })
    return { success: false, error: 'Twilio not configured' }
  }

  const fromNumber = env.TWILIO_PHONE_NUMBER || env.TWILIO_ACCOUNT_SID
  
  // Format numbers for WhatsApp
  const toWhatsApp = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`
  const fromWhatsApp = fromNumber.startsWith('whatsapp:') ? fromNumber : `whatsapp:${fromNumber}`

  try {
    const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          From: fromWhatsApp,
          To: toWhatsApp,
          Body: message,
        }),
      }
    )

    const result = await response.json() as { message?: string; sid?: string }
    
    if (!response.ok) {
      return { success: false, error: result.message || 'Twilio error' }
    }
    
    return { success: true, sid: result.sid }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

// Generic notification endpoint
app.post('/api/notifications/send', async (c) => {
  try {
    const body = await c.req.json()
    const { type, to, subject, message, html, data } = body

    if (!type || !to) {
      return c.json({ error: 'Type and recipient (to) are required' }, 400)
    }

    let result: { success: boolean; error?: string; id?: string; sid?: string }

    switch (type) {
      case 'email':
        if (!subject || (!message && !html)) {
          return c.json({ error: 'Subject and message/html are required for email' }, 400)
        }
        result = await sendEmail(c.env, to, subject, html || message, message)
        break

      case 'whatsapp':
        if (!message) {
          return c.json({ error: 'Message is required for WhatsApp' }, 400)
        }
        const waResult = await sendWhatsApp(c.env, to, message)
        result = { success: waResult.success, error: waResult.error, sid: waResult.sid }
        break

      case 'rfq_confirmation':
        // Auto-generated RFQ confirmation email
        const rfqHtml = html || `
          <h2>RFQ Received - Thank You!</h2>
          <p>Dear ${data?.contact_name || 'Customer'},</p>
          <p>We have received your Request for Quote. Our team will review your requirements and get back to you within 24-48 hours.</p>
          <h3>RFQ Details:</h3>
          <ul>
            <li><strong>Company:</strong> ${data?.company_name || 'N/A'}</li>
            <li><strong>Service Type:</strong> ${data?.service_type || 'N/A'}</li>
            <li><strong>Budget:</strong> ${data?.estimated_budget || 'Not specified'}</li>
            <li><strong>Timeline:</strong> ${data?.timeline || 'Not specified'}</li>
          </ul>
          <p>If you have any questions, please reply to this email.</p>
          <p>Best regards,<br>RevenueForge Team</p>
        `
        result = await sendEmail(c.env, to, subject || 'Your RFQ Has Been Received', rfqHtml)
        break

      case 'followup_reminder':
        // WhatsApp follow-up reminder
        const waMessage = message || `🔔 Follow-up Reminder\n\nLead: ${data?.company_name || 'N/A'}\nScheduled: ${data?.scheduled_at || 'Soon'}\nNotes: ${data?.notes || 'No notes'}\n\nPlease follow up with this lead.`
        const waReminderResult = await sendWhatsApp(c.env, to, waMessage)
        result = { success: waReminderResult.success, error: waReminderResult.error, sid: waReminderResult.sid }
        break

      default:
        return c.json({ error: `Unknown notification type: ${type}` }, 400)
    }

    if (result.success) {
      return c.json({ 
        success: true, 
        message: `${type} notification sent successfully`,
        id: result.id,
        sid: result.sid 
      })
    } else {
      return c.json({ 
        success: false, 
        error: result.error || 'Failed to send notification' 
      }, 500)
    }

  } catch (error) {
    console.error('Notification error:', error)
    return c.json({ error: 'Failed to process notification' }, 500)
  }
})

// Health check
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

// ============ AUTH ROUTES ============

// POST /api/auth/register - Create new user
app.post('/api/auth/register', async (c) => {
  try {
    const body = await c.req.json()
    const { email, password, first_name, last_name, role, phone } = body

    // Validate required fields
    if (!email || !password) {
      return c.json({ error: 'Email and password are required' }, 400)
    }

    // Validate password strength (min 6 chars)
    if (password.length < 6) {
      return c.json({ error: 'Password must be at least 6 characters' }, 400)
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return c.json({ error: 'Invalid email format' }, 400)
    }

    // Check if user already exists
    const existingUser = await c.env.DB.prepare(
      'SELECT id FROM users WHERE email = ?'
    ).bind(email.toLowerCase()).first()

    if (existingUser) {
      return c.json({ error: 'User with this email already exists' }, 409)
    }

    // Hash password with bcrypt
    const password_hash = await bcrypt.hash(password, 10)
    const id = 'usr_' + crypto.randomUUID().replace(/-/g, '').substring(0, 16)
    const now = new Date().toISOString()

    // Insert user
    await c.env.DB.prepare(`
      INSERT INTO users (id, email, password_hash, first_name, last_name, role, phone, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).bind(
      id,
      email.toLowerCase(),
      password_hash,
      first_name || null,
      last_name || null,
      role || 'user',
      phone || null,
      now,
      now
    ).run()

    // Create JWT token
    const token = await createToken(
      { user_id: id, email: email.toLowerCase(), role: role || 'user' },
      c.env.JWT_SECRET
    )

    // Set cookie
    c.header('Set-Cookie', `token=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax`)

    return c.json({
      success: true,
      message: 'User created successfully',
      user: {
        id,
        email: email.toLowerCase(),
        first_name,
        last_name,
        role: role || 'user'
      },
      token
    }, 201)
  } catch (error) {
    console.error('Register error:', error)
    return c.json({ error: 'Failed to register user' }, 500)
  }
})

// POST /api/auth/login - Authenticate user
app.post('/api/auth/login', async (c) => {
  try {
    const body = await c.req.json()
    const { email, password } = body

    // Validate required fields
    if (!email || !password) {
      return c.json({ error: 'Email and password are required' }, 400)
    }

    // Check rate limit
    const rateLimit = await checkRateLimit(c.env.DB, email)
    if (!rateLimit.allowed) {
      c.header('Retry-After', String(Math.ceil(rateLimit.resetIn / 1000)))
      return c.json({
        error: 'Too many login attempts. Please try again later.',
        retry_after: Math.ceil(rateLimit.resetIn / 1000)
      }, 429)
    }

    // Find user by email
    const user = await c.env.DB.prepare(`
      SELECT id, email, password_hash, first_name, last_name, role, phone, is_active, last_login_at
      FROM users WHERE email = ?
    `).bind(email.toLowerCase()).first() as any

    if (!user) {
      return c.json({ error: 'Invalid email or password' }, 401)
    }

    // Check if user is active
    if (!user.is_active) {
      return c.json({ error: 'Account is deactivated' }, 403)
    }

    // Verify password
    const passwordValid = await bcrypt.compare(password, user.password_hash)
    if (!passwordValid) {
      return c.json({ error: 'Invalid email or password' }, 401)
    }

    // Update last login
    const now = new Date().toISOString()
    await c.env.DB.prepare(
      'UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?'
    ).bind(now, now, user.id).run()

    // Create JWT token (24h expiry)
    const token = await createToken(
      { user_id: user.id, email: user.email, role: user.role },
      c.env.JWT_SECRET
    )

    // Set HttpOnly cookie
    c.header('Set-Cookie', `token=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax`)

    return c.json({
      success: true,
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        phone: user.phone
      },
      token
    })
  } catch (error) {
    console.error('Login error:', error)
    return c.json({ error: 'Failed to login' }, 500)
  }
})

// POST /api/auth/logout - Clear auth cookie
app.post('/api/auth/logout', async (c) => {
  // Clear the cookie
  c.header('Set-Cookie', 'token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax')
  return c.json({ success: true, message: 'Logged out successfully' })
})

// GET /api/auth/me - Get current user
app.get('/api/auth/me', async (c) => {
  try {
    const cookies = parseCookies(c.req.header('Cookie'))
    const token = cookies.token || c.req.header('Authorization')?.replace('Bearer ', '')
    
    if (!token) {
      return c.json({ error: 'Not authenticated' }, 401)
    }

    const result = await verifyToken(token, c.env.JWT_SECRET)
    
    if (!result.valid) {
      return c.json({ error: 'Invalid or expired token' }, 401)
    }

    // Fetch fresh user data
    const user = await c.env.DB.prepare(`
      SELECT id, email, first_name, last_name, role, phone, is_active, last_login_at, created_at
      FROM users WHERE id = ?
    `).bind(result.payload.user_id).first() as any

    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }

    if (!user.is_active) {
      return c.json({ error: 'Account is deactivated' }, 403)
    }

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        phone: user.phone,
        last_login_at: user.last_login_at,
        created_at: user.created_at
      }
    })
  } catch (error) {
    console.error('Me error:', error)
    return c.json({ error: 'Failed to get user' }, 500)
  }
})

// Contact form
app.post('/api/contact', async (c) => {
  try {
    const body = await c.req.json()
    const { name, email, company, message } = body
    if (!name || !email || !message) {
      return c.json({ error: 'Name, email, and message are required' }, 400)
    }
    console.log('Contact form:', { name, email, company, message })
    return c.json({ success: true, message: 'Thank you! We will be in touch soon.' })
  } catch (error) {
    return c.json({ error: 'Failed to process' }, 500)
  }
})

// ============================================
// PRODUCTS API - Full CRUD + Image Upload
// ============================================

// Cache keys for products
const PRODUCTS_CACHE_KEY = 'products:all'
const PRODUCT_CACHE_PREFIX = 'product:'
const PRODUCTS_CACHE_TTL = 300 // 5 minutes

// Helper to invalidate product cache
async function invalidateProductsCache(c: any): Promise<void> {
  if (c.env.CACHE) {
    await c.env.CACHE.delete(PRODUCTS_CACHE_KEY)
  }
}

async function invalidateProductCache(c: any, productId: string): Promise<void> {
  if (c.env.CACHE) {
    await c.env.CACHE.delete(`${PRODUCT_CACHE_PREFIX}${productId}`)
    await c.env.CACHE.delete(PRODUCTS_CACHE_KEY)
  }
}

// Admin middleware for product CUD operations
async function adminMiddleware(c: any, next: () => Promise<void>) {
  const cookies = parseCookies(c.req.header('Cookie'))
  const token = cookies.token || c.req.header('Authorization')?.replace('Bearer ', '')
  
  if (!token) {
    return c.json({ error: 'Authentication required' }, 401)
  }
  
  const result = await verifyToken(token, c.env.JWT_SECRET)
  
  if (!result.valid) {
    return c.json({ error: 'Invalid or expired token' }, 401)
  }
  
  if (result.payload.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403)
  }
  
  c.set('user', result.payload)
  await next()
}

// GET /api/products - Returns all products with pagination (public)
app.get('/api/products', async (c) => {
  try {
    // Parse pagination params
    const page = Math.max(1, parseInt(c.req.query('page') || '1'))
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))
    const offset = (page - 1) * limit
    const category = c.req.query('category')
    const search = c.req.query('search')
    const includeInactive = c.req.query('includeInactive') === 'true'
    
    // Build cache key based on params
    const cacheKey = `${PRODUCTS_CACHE_KEY}:${page}:${limit}:${category || 'all'}:${search || 'none'}:${includeInactive}`
    
    // Try cache first
    if (c.env.CACHE) {
      const cached = await c.env.CACHE.get(cacheKey, 'json')
      if (cached) {
        return c.json({ ...cached, cached: true })
      }
    }
    
    // Build query
    let whereClause = includeInactive ? '1=1' : 'is_active = 1'
    const params: any[] = []
    
    if (category) {
      whereClause += ' AND category = ?'
      params.push(category)
    }
    
    if (search) {
      whereClause += ' AND (name LIKE ? OR description LIKE ? OR sku LIKE ?)'
      const searchTerm = `%${search}%`
      params.push(searchTerm, searchTerm, searchTerm)
    }
    
    // Get total count
    const countResult = await c.env.DB.prepare(
      `SELECT COUNT(*) as total FROM products WHERE ${whereClause}`
    ).bind(...params).first() as { total: number }
    const total = countResult?.total || 0
    
    // Get paginated results
    const { results } = await c.env.DB.prepare(
      `SELECT id, sku, name, description, category, industry, price, 
              in_stock, is_active, image_url, technical_specs, created_at, updated_at
       FROM products 
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all()
    
    // Parse technical_specs JSON and map to expected response format
    const products = (results || []).map((p: any) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      description: p.description,
      category: p.category,
      industry: p.industry,
      base_price: p.price, // Map price -> base_price for API response
      stock_quantity: p.in_stock, // Map in_stock -> stock_quantity for API response
      is_active: p.is_active,
      image_url: p.image_url,
      specifications: p.technical_specs ? JSON.parse(p.technical_specs) : null, // Map technical_specs -> specifications
      created_at: p.created_at,
      updated_at: p.updated_at
    }))
    
    const response = {
      success: true,
      data: products,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + limit < total
      }
    }
    
    // Cache for 5 minutes
    if (c.env.CACHE) {
      await c.env.CACHE.put(cacheKey, JSON.stringify(response), {
        expirationTtl: PRODUCTS_CACHE_TTL
      })
    }
    
    return c.json({ ...response, cached: false })
  } catch (error) {
    console.error('Error fetching products:', error)
    return c.json({ error: 'Failed to fetch products' }, 500)
  }
})

// GET /api/products/:id - Returns single product (public)
app.get('/api/products/:id', async (c) => {
  try {
    const productId = c.req.param('id')
    const cacheKey = `${PRODUCT_CACHE_PREFIX}${productId}`
    
    // Try cache first
    if (c.env.CACHE) {
      const cached = await c.env.CACHE.get(cacheKey, 'json')
      if (cached) {
        return c.json({ success: true, data: cached, cached: true })
      }
    }
    
    const product = await c.env.DB.prepare(
      `SELECT id, sku, name, description, category, industry, price,
              in_stock, is_active, image_url, technical_specs, created_at, updated_at
       FROM products WHERE id = ?`
    ).bind(productId).first() as any
    
    if (!product) {
      return c.json({ error: 'Product not found' }, 404)
    }
    
    // Map database columns to API response format
    const response = {
      id: product.id,
      sku: product.sku,
      name: product.name,
      description: product.description,
      category: product.category,
      industry: product.industry,
      base_price: product.price, // Map price -> base_price
      stock_quantity: product.in_stock, // Map in_stock -> stock_quantity
      is_active: product.is_active,
      image_url: product.image_url,
      specifications: product.technical_specs ? JSON.parse(product.technical_specs) : null, // Map technical_specs -> specifications
      created_at: product.created_at,
      updated_at: product.updated_at
    }
    
    // Cache for 5 minutes
    if (c.env.CACHE) {
      await c.env.CACHE.put(cacheKey, JSON.stringify(response), {
        expirationTtl: PRODUCTS_CACHE_TTL
      })
    }
    
    return c.json({ success: true, data: response, cached: false })
  } catch (error) {
    console.error('Error fetching product:', error)
    return c.json({ error: 'Failed to fetch product' }, 500)
  }
})

// POST /api/products - Creates product (admin only)
app.post('/api/products', adminMiddleware, async (c) => {
  try {
    const body = await c.req.json()
    
    // Validate required fields
    if (!body.name || !body.sku) {
      return c.json({ error: 'Name and SKU are required' }, 400)
    }
    
    // Check if SKU already exists
    const existing = await c.env.DB.prepare(
      'SELECT id FROM products WHERE sku = ?'
    ).bind(body.sku).first()
    
    if (existing) {
      return c.json({ error: 'Product with this SKU already exists' }, 409)
    }
    
    const id = 'prod_' + crypto.randomUUID().replace(/-/g, '').substring(0, 16)
    const now = new Date().toISOString()
    
    // Map API fields to database columns
    // base_price -> price, stock_quantity -> in_stock, specifications -> technical_specs
    // cost_price and unit are not stored (columns don't exist in DB)
    
    await c.env.DB.prepare(`
      INSERT INTO products (id, sku, name, description, category, industry, price, in_stock, is_active, technical_specs, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      body.sku,
      body.name,
      body.description || null,
      body.category || null,
      body.industry || null,
      body.base_price || 0, // Map base_price -> price
      body.stock_quantity !== undefined ? (body.stock_quantity ? 1 : 0) : 1, // Map stock_quantity -> in_stock
      body.is_active !== false ? 1 : 0,
      body.specifications ? JSON.stringify(body.specifications) : null, // Map specifications -> technical_specs
      now,
      now
    ).run()
    
    // Invalidate cache
    await invalidateProductsCache(c)
    
    return c.json({
      success: true,
      message: 'Product created successfully',
      data: { id, sku: body.sku, name: body.name }
    }, 201)
  } catch (error) {
    console.error('Error creating product:', error)
    return c.json({ error: 'Failed to create product' }, 500)
  }
})

// PATCH /api/products/:id - Updates product (admin only)
app.patch('/api/products/:id', adminMiddleware, async (c) => {
  try {
    const productId = c.req.param('id')
    const body = await c.req.json()
    
    // Check if product exists
    const existing = await c.env.DB.prepare(
      'SELECT id, sku FROM products WHERE id = ?'
    ).bind(productId).first() as any
    
    if (!existing) {
      return c.json({ error: 'Product not found' }, 404)
    }
    
    // If SKU is being changed, check for duplicates
    if (body.sku && body.sku !== existing.sku) {
      const skuExists = await c.env.DB.prepare(
        'SELECT id FROM products WHERE sku = ? AND id != ?'
      ).bind(body.sku, productId).first()
      
      if (skuExists) {
        return c.json({ error: 'Product with this SKU already exists' }, 409)
      }
    }
    
    const now = new Date().toISOString()
    const updates: string[] = []
    const values: any[] = []
    
    // Build dynamic update
    // Map API field names to database column names:
    // base_price -> price, stock_quantity -> in_stock, specifications -> technical_specs
    const fieldMapping: Record<string, string> = {
      'sku': 'sku',
      'name': 'name',
      'description': 'description',
      'category': 'category',
      'industry': 'industry',
      'base_price': 'price', // Map
      'stock_quantity': 'in_stock', // Map
      'is_active': 'is_active',
      'specifications': 'technical_specs' // Map
    }
    
    for (const [apiField, dbField] of Object.entries(fieldMapping)) {
      if (body[apiField] !== undefined) {
        updates.push(`${dbField} = ?`)
        if (apiField === 'specifications' && body[apiField]) {
          values.push(JSON.stringify(body[apiField]))
        } else if (apiField === 'stock_quantity') {
          // Convert to integer for in_stock
          values.push(body[apiField] ? 1 : 0)
        } else if (apiField === 'is_active') {
          values.push(body[apiField] ? 1 : 0)
        } else {
          values.push(body[apiField])
        }
      }
    }
    
    if (updates.length === 0) {
      return c.json({ error: 'No valid fields to update' }, 400)
    }
    
    updates.push('updated_at = ?')
    values.push(now)
    values.push(productId)
    
    await c.env.DB.prepare(
      `UPDATE products SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...values).run()
    
    // Invalidate cache
    await invalidateProductCache(c, productId)
    
    return c.json({
      success: true,
      message: 'Product updated successfully'
    })
  } catch (error) {
    console.error('Error updating product:', error)
    return c.json({ error: 'Failed to update product' }, 500)
  }
})

// DELETE /api/products/:id - Deletes product (admin only)
app.delete('/api/products/:id', adminMiddleware, async (c) => {
  try {
    const productId = c.req.param('id')
    
    // Check if product exists
    const existing = await c.env.DB.prepare(
      'SELECT id FROM products WHERE id = ?'
    ).bind(productId).first()
    
    if (!existing) {
      return c.json({ error: 'Product not found' }, 404)
    }
    
    // Hard delete
    await c.env.DB.prepare('DELETE FROM products WHERE id = ?').bind(productId).run()
    
    // Invalidate cache
    await invalidateProductCache(c, productId)
    
    return c.json({
      success: true,
      message: 'Product deleted successfully'
    })
  } catch (error) {
    console.error('Error deleting product:', error)
    return c.json({ error: 'Failed to delete product' }, 500)
  }
})

// POST /api/products/:id/image - Uploads product image (admin only)
app.post('/api/products/:id/image', adminMiddleware, async (c) => {
  try {
    const productId = c.req.param('id')
    
    // Check if product exists
    const existing = await c.env.DB.prepare(
      'SELECT id FROM products WHERE id = ?'
    ).bind(productId).first()
    
    if (!existing) {
      return c.json({ error: 'Product not found' }, 404)
    }
    
    // Check if R2 is configured
    if (!c.env.PRODUCTS_BUCKET) {
      return c.json({ error: 'Image storage not configured' }, 500)
    }
    
    // Parse multipart form data
    const contentType = c.req.header('Content-Type') || ''
    if (!contentType.includes('multipart/form-data')) {
      return c.json({ error: 'Multipart form data required' }, 400)
    }
    
    const formData = await c.req.formData()
    const file = formData.get('image') as File | null
    
    if (!file) {
      return c.json({ error: 'Image file is required' }, 400)
    }
    
    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
    if (!allowedTypes.includes(file.type)) {
      return c.json({ error: 'Invalid image type. Allowed: JPEG, PNG, WebP, GIF' }, 400)
    }
    
    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024
    if (file.size > maxSize) {
      return c.json({ error: 'Image size must be less than 5MB' }, 400)
    }
    
    // Generate unique filename
    const extension = file.name.split('.').pop() || 'jpg'
    const filename = `${productId}/${Date.now()}.${extension}`
    
    // Upload to R2
    await c.env.PRODUCTS_BUCKET.put(filename, file.stream(), {
      httpMetadata: {
        contentType: file.type
      }
    })
    
    // Construct public URL (assumes R2 public bucket or custom domain)
    // Update this to match your actual R2 public URL pattern
    const imageUrl = `https://product-images.revenueforge.com/${filename}`
    
    // Update product with image URL
    await c.env.DB.prepare(
      'UPDATE products SET image_url = ?, updated_at = ? WHERE id = ?'
    ).bind(imageUrl, new Date().toISOString(), productId).run()
    
    // Invalidate cache
    await invalidateProductCache(c, productId)
    
    return c.json({
      success: true,
      message: 'Image uploaded successfully',
      data: {
        url: imageUrl,
        filename
      }
    })
  } catch (error) {
    console.error('Error uploading product image:', error)
    return c.json({ error: 'Failed to upload image' }, 500)
  }
})

// RFQ with email notification
app.post('/api/rfq', async (c) => {
  try {
    const body = await c.req.json()
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    
    await c.env.DB.prepare(
      'INSERT INTO rfq_submissions (id, company_name, contact_name, email, phone, service_type, project_description, estimated_budget, timeline, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, body.company_name, body.contact_name, body.email, body.phone, body.service_type, body.project_description, body.estimated_budget, body.timeline, 'new', body.additional_notes || null, now, now).run()

    // Send confirmation email to customer
    if (body.email) {
      const emailHtml = `
        <h2>RFQ Received - Thank You!</h2>
        <p>Dear ${body.contact_name || 'Customer'},</p>
        <p>We have received your Request for Quote. Our team will review your requirements and get back to you within 24-48 hours.</p>
        <h3>RFQ Details:</h3>
        <ul>
          <li><strong>Company:</strong> ${body.company_name || 'N/A'}</li>
          <li><strong>Service Type:</strong> ${body.service_type || 'N/A'}</li>
          <li><strong>Budget:</strong> ${body.estimated_budget || 'Not specified'}</li>
          <li><strong>Timeline:</strong> ${body.timeline || 'Not specified'}</li>
        </ul>
        <p>If you have any questions, please reply to this email.</p>
        <p>Best regards,<br>RevenueForge Team</p>
      `
      
      await sendEmail(
        c.env,
        body.email,
        'Your RFQ Has Been Received - RevenueForge',
        emailHtml
      )
    }

    // Send notification email to admin
    if (c.env.NOTIFICATION_EMAIL_TO) {
      const adminHtml = `
        <h2>New RFQ Submitted</h2>
        <p>A new RFQ has been submitted and requires your attention.</p>
        <h3>Details:</h3>
        <ul>
          <li><strong>ID:</strong> ${id}</li>
          <li><strong>Company:</strong> ${body.company_name || 'N/A'}</li>
          <li><strong>Contact:</strong> ${body.contact_name || 'N/A'}</li>
          <li><strong>Email:</strong> ${body.email || 'N/A'}</li>
          <li><strong>Phone:</strong> ${body.phone || 'N/A'}</li>
          <li><strong>Service Type:</strong> ${body.service_type || 'N/A'}</li>
          <li><strong>Budget:</strong> ${body.estimated_budget || 'Not specified'}</li>
          <li><strong>Timeline:</strong> ${body.timeline || 'Not specified'}</li>
        </ul>
        <h3>Project Description:</h3>
        <p>${body.project_description || 'No description provided'}</p>
        <p><a href="https://revenueforge.pronitopenclaw.workers.dev/admin/rfq">View in Dashboard</a></p>
      `
      
      await sendEmail(
        c.env,
        c.env.NOTIFICATION_EMAIL_TO,
        `New RFQ: ${body.company_name} - ${body.service_type}`,
        adminHtml
      )
    }

    return c.json({ success: true, id, message: 'RFQ submitted successfully' })
  } catch (error) {
    console.error('RFQ error:', error)
    return c.json({ error: 'Failed to submit RFQ' }, 500)
  }
})

// Get all RFQs
app.get('/api/rfqs', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT * FROM rfq_submissions ORDER BY created_at DESC').all()
    return c.json({ rfqs: results })
  } catch (error) {
    console.error('RFQs fetch error:', error)
    return c.json({ error: 'Failed to fetch RFQs' }, 500)
  }
})

// Leads (CRM)
app.get('/api/leads', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT * FROM leads ORDER BY created_at DESC').all()
    return c.json({ leads: results })
  } catch (error) {
    return c.json({ error: 'Failed to fetch leads' }, 500)
  }
})

app.post('/api/leads', async (c) => {
  try {
    const body = await c.req.json()
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    await c.env.DB.prepare(
      'INSERT INTO leads (id, company_name, contact_name, email, phone, status, assigned_to, source, estimated_value, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, body.company_name, body.contact_name, body.email, body.phone, body.status || 'new', body.assigned_to, body.source, body.estimated_value || 0, body.notes, now, now).run()
    return c.json({ success: true, id })
  } catch (error) {
    return c.json({ error: 'Failed to create lead' }, 500)
  }
})

app.get('/api/leads/:id', async (c) => {
  try {
    const lead = await c.env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(c.req.param('id')).first()
    if (!lead) return c.json({ error: 'Lead not found' }, 404)
    return c.json({ lead })
  } catch (error) {
    return c.json({ error: 'Failed to fetch lead' }, 500)
  }
})

app.patch('/api/leads/:id', async (c) => {
  try {
    const body = await c.req.json()
    const now = new Date().toISOString()
    await c.env.DB.prepare('UPDATE leads SET status = ?, updated_at = ? WHERE id = ?').bind(body.status, now, c.req.param('id')).run()
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: 'Failed to update lead' }, 500)
  }
})

// Lead activities
app.get('/api/leads/:id/activities', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT * FROM lead_activities WHERE lead_id = ? ORDER BY created_at DESC').bind(c.req.param('id')).all()
    return c.json({ activities: results })
  } catch (error) {
    return c.json({ error: 'Failed to fetch activities' }, 500)
  }
})

app.post('/api/leads/:id/activities', async (c) => {
  try {
    const body = await c.req.json()
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    await c.env.DB.prepare('INSERT INTO lead_activities (id, lead_id, type, description, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)').bind(id, c.req.param('id'), body.type, body.description, now, body.created_by).run()
    return c.json({ success: true, id })
  } catch (error) {
    return c.json({ error: 'Failed to create activity' }, 500)
  }
})

// Follow-ups
app.get('/api/leads/:id/follow-ups', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT * FROM follow_ups WHERE lead_id = ? ORDER BY scheduled_at ASC').bind(c.req.param('id')).all()
    return c.json({ follow_ups: results })
  } catch (error) {
    return c.json({ error: 'Failed to fetch follow-ups' }, 500)
  }
})

app.post('/api/leads/:id/follow-ups', async (c) => {
  try {
    const body = await c.req.json()
    const id = crypto.randomUUID()
    await c.env.DB.prepare('INSERT INTO follow_ups (id, lead_id, scheduled_at, notes, completed, completed_at) VALUES (?, ?, ?, ?, 0, NULL)').bind(id, c.req.param('id'), body.scheduled_at, body.notes).run()
    return c.json({ success: true, id })
  } catch (error) {
    return c.json({ error: 'Failed to create follow-up' }, 500)
  }
})

// Mark follow-up as complete and send WhatsApp reminder if needed
app.patch('/api/leads/:leadId/follow-ups/:id', async (c) => {
  try {
    const body = await c.req.json()
    const now = new Date().toISOString()
    
    if (body.completed) {
      await c.env.DB.prepare(
        'UPDATE follow_ups SET completed = 1, completed_at = ?, notes = COALESCE(?, notes) WHERE id = ? AND lead_id = ?'
      ).bind(now, body.notes, c.req.param('id'), c.req.param('leadId')).run()
    } else {
      await c.env.DB.prepare(
        'UPDATE follow_ups SET notes = COALESCE(?, notes) WHERE id = ? AND lead_id = ?'
      ).bind(body.notes, c.req.param('id'), c.req.param('leadId')).run()
    }

    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: 'Failed to update follow-up' }, 500)
  }
})

// Get upcoming follow-ups (for WhatsApp reminders)
app.get('/api/follow-ups/upcoming', async (c) => {
  try {
    const hours = parseInt(c.req.query('hours') || '24')
    const now = new Date().toISOString()
    const future = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
    
    const { results } = await c.env.DB.prepare(`
      SELECT fu.*, l.company_name, l.contact_name, l.phone as lead_phone
      FROM follow_ups fu
      JOIN leads l ON fu.lead_id = l.id
      WHERE fu.scheduled_at BETWEEN ? AND ?
      AND fu.completed = 0
      ORDER BY fu.scheduled_at ASC
    `).bind(now, future).all()
    
    return c.json({ follow_ups: results })
  } catch (error) {
    return c.json({ error: 'Failed to fetch upcoming follow-ups' }, 500)
  }
})

// Send WhatsApp reminders for upcoming follow-ups
app.post('/api/follow-ups/send-reminders', async (c) => {
  try {
    const hours = parseInt(c.req.query('hours') || '24')
    const now = new Date().toISOString()
    const future = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
    
    // Get upcoming follow-ups with lead info
    const { results } = await c.env.DB.prepare(`
      SELECT fu.*, l.company_name, l.contact_name, l.phone as lead_phone
      FROM follow_ups fu
      JOIN leads l ON fu.lead_id = l.id
      WHERE fu.scheduled_at BETWEEN ? AND ?
      AND fu.completed = 0
      ORDER BY fu.scheduled_at ASC
    `).bind(now, future).all()
    
    const followUps = (results || []) as Array<{
      id: string
      company_name?: string
      contact_name?: string
      scheduled_at: string
      notes?: string
    }>
    const sent: string[] = []
    const failed: string[] = []
    
    for (const fu of followUps) {
      const message = `🔔 Follow-up Reminder

Lead: ${fu.company_name || 'N/A'}
Contact: ${fu.contact_name || 'N/A'}
Scheduled: ${new Date(fu.scheduled_at).toLocaleString()}
Notes: ${fu.notes || 'No notes'}

Please follow up with this lead.`

      // Send to admin WhatsApp
      const toNumber = c.env.ADMIN_WHATSAPP_NUMBER
      if (toNumber) {
        const result = await sendWhatsApp(c.env, toNumber, message)
        if (result.success) {
          sent.push(fu.id as string)
        } else {
          failed.push(fu.id as string)
          console.error(`Failed to send WhatsApp for follow-up ${fu.id}:`, result.error)
        }
      } else {
        console.log('Would send WhatsApp reminder:', { to: 'ADMIN', message })
        sent.push(fu.id as string)
      }
    }
    
    return c.json({ 
      success: true, 
      sent: sent.length, 
      failed: failed.length,
      followUpIds: sent
    })
  } catch (error) {
    console.error('Send reminders error:', error)
    return c.json({ error: 'Failed to send reminders' }, 500)
  }
})

// ============ QUOTES API ============

// Get all quotes (with optional status filter)
app.get('/api/quotes', async (c) => {
  try {
    const status = c.req.query('status')
    let query = 'SELECT * FROM quotes ORDER BY created_at DESC'
    const params: any[] = []
    
    if (status && status !== 'all') {
      query = 'SELECT * FROM quotes WHERE status = ? ORDER BY created_at DESC'
      params.push(status)
    }
    
    const { results } = await c.env.DB.prepare(query).bind(...params).all()
    
    // Fetch items for each quote
    const quotes = (results || []) as Array<{ id: string }>
    const quotesWithItems = await Promise.all(
      quotes.map(async (quote) => {
        const { results: items } = await c.env.DB.prepare(
          'SELECT * FROM quote_items WHERE quote_id = ?'
        ).bind(quote.id).all()
        return { ...quote, items: items || [] }
      })
    )
    
    return c.json({ success: true, data: quotesWithItems })
  } catch (error) {
    console.error('Quotes fetch error:', error)
    return c.json({ success: false, error: 'Failed to fetch quotes' }, 500)
  }
})

// Get single quote
app.get('/api/quotes/:id', async (c) => {
  try {
    const quote = await c.env.DB.prepare('SELECT * FROM quotes WHERE id = ?').bind(c.req.param('id')).first()
    if (!quote) return c.json({ success: false, error: 'Quote not found' }, 404)
    
    const { results: items } = await c.env.DB.prepare(
      'SELECT * FROM quote_items WHERE quote_id = ?'
    ).bind(quote.id).all()
    
    return c.json({ success: true, data: { ...quote, items: items || [] } })
  } catch (error) {
    console.error('Quote fetch error:', error)
    return c.json({ success: false, error: 'Failed to fetch quote' }, 500)
  }
})

// Create quote
app.post('/api/quotes', async (c) => {
  try {
    const body = await c.req.json()
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    
    // Calculate valid_until based on validity_days
    const validityDays = body.validity_days || 30
    const validUntil = new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000).toISOString()
    
    // If rfq_id provided, fetch lead info
    let companyName = body.company_name
    let contactName = body.contact_name
    let email = body.email
    let phone = body.phone
    
    if (body.rfq_id) {
      const lead = await c.env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(body.rfq_id).first() as any
      if (lead) {
        companyName = companyName || lead.company_name
        contactName = contactName || lead.contact_name
        email = email || lead.email
        phone = phone || lead.phone
      }
    }
    
    // Calculate total amount from items
    const items = body.items || []
    const amount = items.reduce((sum: number, item: any) => sum + (item.total_price || 0), 0)
    
    await c.env.DB.prepare(`
      INSERT INTO quotes (id, rfq_id, company_name, contact_name, email, phone, amount, currency, validity_days, valid_until, terms, status, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      body.rfq_id || null,
      companyName,
      contactName,
      email,
      phone,
      amount,
      body.currency || 'USD',
      validityDays,
      validUntil,
      body.terms || null,
      body.status || 'draft',
      body.notes || null,
      now,
      now
    ).run()
    
    // Insert quote items
    for (const item of items) {
      const itemId = crypto.randomUUID()
      await c.env.DB.prepare(`
        INSERT INTO quote_items (id, quote_id, product_id, description, quantity, unit_price, total_price, product_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        itemId,
        id,
        item.product_id || null,
        item.description || null,
        item.quantity || 1,
        item.unit_price || 0,
        item.total_price || 0,
        item.product_name || null
      ).run()
    }
    
    // Fetch the created quote with items
    const quote = await c.env.DB.prepare('SELECT * FROM quotes WHERE id = ?').bind(id).first()
    const { results: quoteItems } = await c.env.DB.prepare('SELECT * FROM quote_items WHERE quote_id = ?').bind(id).all()
    
    return c.json({ success: true, data: { ...quote, items: quoteItems || [] } })
  } catch (error) {
    console.error('Quote create error:', error)
    return c.json({ success: false, error: 'Failed to create quote' }, 500)
  }
})

// Update quote status
app.patch('/api/quotes/:id/status', async (c) => {
  try {
    const body = await c.req.json()
    const now = new Date().toISOString()
    const newStatus = body.status
    
    // Get current quote
    const quote = await c.env.DB.prepare('SELECT * FROM quotes WHERE id = ?').bind(c.req.param('id')).first() as any
    if (!quote) return c.json({ success: false, error: 'Quote not found' }, 404)
    
    // Build update query based on status
    let sentAt = quote.sent_at
    let acceptedAt = quote.accepted_at
    let rejectedAt = quote.rejected_at
    
    if (newStatus === 'sent' && !quote.sent_at) {
      sentAt = now
    } else if (newStatus === 'accepted' && !quote.accepted_at) {
      acceptedAt = now
    } else if (newStatus === 'rejected' && !quote.rejected_at) {
      rejectedAt = now
    }
    
    await c.env.DB.prepare(`
      UPDATE quotes SET status = ?, sent_at = ?, accepted_at = ?, rejected_at = ?, updated_at = ?
      WHERE id = ?
    `).bind(newStatus, sentAt, acceptedAt, rejectedAt, now, c.req.param('id')).run()
    
    // Fetch updated quote
    const updatedQuote = await c.env.DB.prepare('SELECT * FROM quotes WHERE id = ?').bind(c.req.param('id')).first()
    const { results: items } = await c.env.DB.prepare('SELECT * FROM quote_items WHERE quote_id = ?').bind(c.req.param('id')).all()
    
    // Send email notification if quote is sent
    if (newStatus === 'sent' && quote.email) {
      const emailHtml = `
        <h2>Your Quotation from RevenueForge</h2>
        <p>Dear ${quote.contact_name || 'Customer'},</p>
        <p>Please find attached your quotation. This quote is valid until ${new Date(quote.valid_until).toLocaleDateString()}.</p>
        <p>Total Amount: ${quote.currency || 'USD'} ${quote.amount.toFixed(2)}</p>
        <p>If you have any questions or would like to proceed, please reply to this email.</p>
        <p>Best regards,<br>RevenueForge Team</p>
      `
      
      await sendEmail(c.env, quote.email, 'Your Quotation - RevenueForge', emailHtml)
    }
    
    return c.json({ success: true, data: { ...updatedQuote, items: items || [] } })
  } catch (error) {
    console.error('Quote status update error:', error)
    return c.json({ success: false, error: 'Failed to update quote status' }, 500)
  }
})

// Delete quote
app.delete('/api/quotes/:id', async (c) => {
  try {
    await c.env.DB.prepare('DELETE FROM quote_items WHERE quote_id = ?').bind(c.req.param('id')).run()
    await c.env.DB.prepare('DELETE FROM quotes WHERE id = ?').bind(c.req.param('id')).run()
    return c.json({ success: true })
  } catch (error) {
    console.error('Quote delete error:', error)
    return c.json({ success: false, error: 'Failed to delete quote' }, 500)
  }
})

// Daily summary report
app.get('/api/reports/daily-summary', async (c) => {
  try {
    const days = parseInt(c.req.query('days') || '1')
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    
    // Get new leads
    const { results: newLeads } = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM leads WHERE created_at > ?'
    ).bind(since).all()
    
    // Get new RFQs
    const { results: newRfqs } = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM rfq_submissions WHERE created_at > ?'
    ).bind(since).all()
    
    // Get leads by status
    const { results: leadsByStatus } = await c.env.DB.prepare(
      'SELECT status, COUNT(*) as count FROM leads GROUP BY status'
    ).all()
    
    // Get upcoming follow-ups
    const now = new Date().toISOString()
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const { results: upcomingFollowUps } = await c.env.DB.prepare(`
      SELECT fu.*, l.company_name, l.contact_name
      FROM follow_ups fu
      JOIN leads l ON fu.lead_id = l.id
      WHERE fu.scheduled_at > ? AND fu.scheduled_at < ? AND fu.completed = 0
      ORDER BY fu.scheduled_at ASC
    `).bind(now, tomorrow).all()
    
    return c.json({
      period: `Last ${days} day(s)`,
      summary: {
        newLeads: (newLeads?.[0] as any)?.count || 0,
        newRfqs: (newRfqs?.[0] as any)?.count || 0,
        leadsByStatus: leadsByStatus || [],
        upcomingFollowUps: (upcomingFollowUps || []).length
      },
      followUps: upcomingFollowUps || []
    })
  } catch (error) {
    return c.json({ error: 'Failed to generate summary' }, 500)
  }
})

// Send daily summary email
app.post('/api/reports/send-daily-summary', async (c) => {
  try {
    const days = parseInt(c.req.query('days') || '1')
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    
    // Get new leads
    const { results: newLeads } = await c.env.DB.prepare(
      'SELECT * FROM leads WHERE created_at > ? ORDER BY created_at DESC'
    ).bind(since).all()
    
    // Get new RFQs
    const { results: newRfqs } = await c.env.DB.prepare(
      'SELECT * FROM rfq_submissions WHERE created_at > ? ORDER BY created_at DESC'
    ).bind(since).all()
    
    // Get leads by status
    const { results: leadsByStatus } = await c.env.DB.prepare(
      'SELECT status, COUNT(*) as count FROM leads GROUP BY status'
    ).all()
    
    // Get upcoming follow-ups
    const now = new Date().toISOString()
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const { results: upcomingFollowUps } = await c.env.DB.prepare(`
      SELECT fu.*, l.company_name, l.contact_name
      FROM follow_ups fu
      JOIN leads l ON fu.lead_id = l.id
      WHERE fu.scheduled_at > ? AND fu.scheduled_at < ? AND fu.completed = 0
      ORDER BY fu.scheduled_at ASC
    `).bind(now, tomorrow).all()
    
    const to = c.env.NOTIFICATION_EMAIL_TO
    if (!to) {
      return c.json({ error: 'No notification email configured' }, 400)
    }
    
    const date = new Date().toLocaleDateString()
    const html = `
      <h2>📊 RevenueForge Daily Summary - ${date}</h2>
      
      <h3>📈 Activity (Last ${days} Day${days > 1 ? 's' : ''})</h3>
      <ul>
        <li><strong>New Leads:</strong> ${(newLeads || []).length}</li>
        <li><strong>New RFQs:</strong> ${(newRfqs || []).length}</li>
      </ul>
      
      <h3>📋 Leads by Status</h3>
      <ul>
        ${(leadsByStatus || []).map((s: any) => `<li>${s.status}: ${s.count}</li>`).join('')}
      </ul>
      
      ${(newLeads || []).length > 0 ? `
      <h3>🆕 New Leads</h3>
      <table border="1" cellpadding="5" style="border-collapse: collapse;">
        <tr><th>Company</th><th>Contact</th><th>Status</th><th>Value</th></tr>
        ${(newLeads || []).map((l: any) => `
          <tr>
            <td>${l.company_name || 'N/A'}</td>
            <td>${l.contact_name || 'N/A'}</td>
            <td>${l.status || 'N/A'}</td>
            <td>${l.estimated_value || 0}</td>
          </tr>
        `).join('')}
      </table>
      ` : ''}
      
      ${(newRfqs || []).length > 0 ? `
      <h3>📝 New RFQs</h3>
      <table border="1" cellpadding="5" style="border-collapse: collapse;">
        <tr><th>Company</th><th>Service</th><th>Budget</th><th>Timeline</th></tr>
        ${(newRfqs || []).map((r: any) => `
          <tr>
            <td>${r.company_name || 'N/A'}</td>
            <td>${r.service_type || 'N/A'}</td>
            <td>${r.estimated_budget || 'Not specified'}</td>
            <td>${r.timeline || 'Not specified'}</td>
          </tr>
        `).join('')}
      </table>
      ` : ''}
      
      ${(upcomingFollowUps || []).length > 0 ? `
      <h3>🔔 Upcoming Follow-ups (Next 24h)</h3>
      <table border="1" cellpadding="5" style="border-collapse: collapse;">
        <tr><th>Company</th><th>Contact</th><th>Scheduled</th><th>Notes</th></tr>
        ${(upcomingFollowUps || []).map((f: any) => `
          <tr>
            <td>${f.company_name || 'N/A'}</td>
            <td>${f.contact_name || 'N/A'}</td>
            <td>${new Date(f.scheduled_at).toLocaleString()}</td>
            <td>${f.notes || 'No notes'}</td>
          </tr>
        `).join('')}
      </table>
      ` : '<p>No upcoming follow-ups in the next 24 hours.</p>'}
      
      <hr>
      <p><a href="https://revenueforge.pronitopenclaw.workers.dev/admin">View Dashboard</a></p>
    `
    
    const result = await sendEmail(c.env, to, `RevenueForge Daily Summary - ${date}`, html)
    
    if (result.success) {
      return c.json({
        success: true,
        message: 'Daily summary sent',
        data: {
          newLeads: (newLeads || []).length,
          newRfqs: (newRfqs || []).length,
          upcomingFollowUps: (upcomingFollowUps || []).length
        }
      })
    } else {
      return c.json({ success: false, error: result.error }, 500)
    }
  } catch (error) {
    console.error('Daily summary error:', error)
    return c.json({ error: 'Failed to send daily summary' }, 500)
  }
})

// ============================================
// SETTINGS API - White-Label Configuration
// ============================================

// Branding fields that are safe to expose publicly
const BRANDING_FIELDS = [
  'company_name',
  'logo_url',
  'primary_color',
  'accent_color',
  'tagline',
  'company_address',
  'company_phone',
  'company_email'
]

// Cache settings in KV for fast access
const SETTINGS_CACHE_KEY = 'settings:public'
const SETTINGS_CACHE_TTL = 3600 // 1 hour

// GET /api/settings - Returns branding fields (public access)
app.get('/api/settings', async (c) => {
  try {
    // Try to get from cache first
    if (c.env.CACHE) {
      const cached = await c.env.CACHE.get(SETTINGS_CACHE_KEY, 'json')
      if (cached) {
        return c.json({ success: true, data: cached, cached: true })
      }
    }

    // Fetch branding settings from database
    const placeholders = BRANDING_FIELDS.map(() => '?').join(',')
    const { results } = await c.env.DB.prepare(
      `SELECT key, value, type FROM settings WHERE key IN (${placeholders})`
    ).bind(...BRANDING_FIELDS).all()

    // Parse values based on type
    const settings: Record<string, any> = {}
    for (const row of results || []) {
      const { key, value, type } = row as any
      let parsedValue = value

      if (type === 'number') {
        parsedValue = parseFloat(value) || 0
      } else if (type === 'boolean') {
        parsedValue = value === 'true' || value === '1'
      } else if (type === 'json') {
        try {
          parsedValue = JSON.parse(value)
        } catch {
          parsedValue = value
        }
      }

      settings[key] = parsedValue
    }

    // Cache in KV
    if (c.env.CACHE) {
      await c.env.CACHE.put(SETTINGS_CACHE_KEY, JSON.stringify(settings), {
        expirationTtl: SETTINGS_CACHE_TTL
      })
    }

    return c.json({ success: true, data: settings, cached: false })
  } catch (error) {
    console.error('Error fetching settings:', error)
    return c.json({ error: 'Failed to fetch settings' }, 500)
  }
})

// Admin-only endpoint to get ALL settings (including SMTP)
app.get('/api/settings/admin', authMiddleware, async (c) => {
  try {
    const user = c.get('user') as any
    
    // Check if user is admin
    if (user.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403)
    }

    // Fetch all settings
    const { results } = await c.env.DB.prepare(
      'SELECT key, value, type, category, description, is_editable, created_at, updated_at FROM settings ORDER BY category, key'
    ).all()

    // Parse values
    const settings = (results || []).map((row: any) => {
      let parsedValue = row.value

      if (row.type === 'number') {
        parsedValue = parseFloat(row.value) || 0
      } else if (row.type === 'boolean') {
        parsedValue = row.value === 'true' || row.value === '1'
      } else if (row.type === 'json') {
        try {
          parsedValue = JSON.parse(row.value)
        } catch {
          parsedValue = row.value
        }
      }

      return {
        key: row.key,
        value: parsedValue,
        type: row.type,
        category: row.category,
        description: row.description,
        is_editable: row.is_editable === 1,
        created_at: row.created_at,
        updated_at: row.updated_at
      }
    })

    return c.json({ success: true, data: settings })
  } catch (error) {
    console.error('Error fetching admin settings:', error)
    return c.json({ error: 'Failed to fetch settings' }, 500)
  }
})

// PATCH /api/settings - Update settings (admin only)
app.patch('/api/settings', authMiddleware, async (c) => {
  try {
    const user = c.get('user') as any
    
    // Check if user is admin
    if (user.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403)
    }

    const body = await c.req.json()
    const { settings } = body

    if (!settings || typeof settings !== 'object' || Object.keys(settings).length === 0) {
      return c.json({ error: 'Settings object is required' }, 400)
    }

    const updated: string[] = []
    const notFound: string[] = []
    const notEditable: string[] = []

    // Update each setting
    for (const [key, value] of Object.entries(settings)) {
      // Check if setting exists
      const existing = await c.env.DB.prepare(
        'SELECT key, is_editable FROM settings WHERE key = ?'
      ).bind(key).first() as any

      if (!existing) {
        notFound.push(key)
        continue
      }

      if (!existing.is_editable) {
        notEditable.push(key)
        continue
      }

      // Convert value to string for storage
      let valueStr: string
      if (typeof value === 'object') {
        valueStr = JSON.stringify(value)
      } else {
        valueStr = String(value)
      }

      // Update setting
      await c.env.DB.prepare(
        'UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?'
      ).bind(valueStr, key).run()

      updated.push(key)
    }

    // Invalidate cache
    if (c.env.CACHE && updated.length > 0) {
      await c.env.CACHE.delete(SETTINGS_CACHE_KEY)
    }

    return c.json({
      success: true,
      message: 'Settings updated',
      updated,
      notFound: notFound.length > 0 ? notFound : undefined,
      notEditable: notEditable.length > 0 ? notEditable : undefined
    })
  } catch (error) {
    console.error('Error updating settings:', error)
    return c.json({ error: 'Failed to update settings' }, 500)
  }
})

// ============================================
// DEALER PORTAL API
// ============================================

// GET /api/dealer/orders - List orders filtered by dealer_id
app.get('/api/dealer/orders', authMiddleware, async (c) => {
  try {
    const user = c.get('user') as any
    const dealerId = user.user_id
    
    // Parse query params for filtering
    const status = c.req.query('status')
    const page = Math.max(1, parseInt(c.req.query('page') || '1'))
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))
    const offset = (page - 1) * limit
    
    // Build query
    let whereClause = 'dealer_id = ?'
    const params: any[] = [dealerId]
    
    if (status) {
      whereClause += ' AND status = ?'
      params.push(status)
    }
    
    // Get total count
    const countResult = await c.env.DB.prepare(
      `SELECT COUNT(*) as total FROM orders WHERE ${whereClause}`
    ).bind(...params).first() as { total: number }
    const total = countResult?.total || 0
    
    // Get paginated results
    const { results } = await c.env.DB.prepare(
      `SELECT id, dealer_id, product_id, product_name, quantity, unit_price, 
              total_amount, currency, status, notes, created_at, updated_at
       FROM orders 
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all()
    
    return c.json({
      success: true,
      data: results || [],
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + limit < total
      }
    })
  } catch (error) {
    console.error('Error fetching dealer orders:', error)
    return c.json({ error: 'Failed to fetch orders' }, 500)
  }
})

// GET /api/dealer/commissions - List commissions filtered by dealer_id
app.get('/api/dealer/commissions', authMiddleware, async (c) => {
  try {
    const user = c.get('user') as any
    const dealerId = user.user_id
    
    // Parse query params for filtering
    const status = c.req.query('status')
    const page = Math.max(1, parseInt(c.req.query('page') || '1'))
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))
    const offset = (page - 1) * limit
    
    // Build query
    let whereClause = 'dealer_id = ?'
    const params: any[] = [dealerId]
    
    if (status) {
      whereClause += ' AND status = ?'
      params.push(status)
    }
    
    // Get total count
    const countResult = await c.env.DB.prepare(
      `SELECT COUNT(*) as total FROM commissions WHERE ${whereClause}`
    ).bind(...params).first() as { total: number }
    const total = countResult?.total || 0
    
    // Get paginated results
    const { results } = await c.env.DB.prepare(
      `SELECT id, dealer_id, lead_id, rfq_id, amount, currency, status, notes, 
              paid_at, created_at, updated_at
       FROM commissions 
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all()
    
    // Calculate totals
    const totalsResult = await c.env.DB.prepare(
      `SELECT 
         SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END) as pending_total,
         SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END) as paid_total,
         SUM(amount) as total_commissions
       FROM commissions WHERE dealer_id = ?`
    ).bind(dealerId).first() as { pending_total: number; paid_total: number; total_commissions: number }
    
    return c.json({
      success: true,
      data: results || [],
      summary: {
        pending: totalsResult?.pending_total || 0,
        paid: totalsResult?.paid_total || 0,
        total: totalsResult?.total_commissions || 0
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + limit < total
      }
    })
  } catch (error) {
    console.error('Error fetching dealer commissions:', error)
    return c.json({ error: 'Failed to fetch commissions' }, 500)
  }
})

// Cron handler for scheduled tasks
export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx)
  },
  
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext): Promise<void> {
    console.log('Cron triggered:', event.cron)
    
    // Daily summary at 9 AM
    if (event.cron === '0 9 * * *') {
      console.log('Sending daily summary...')
      try {
        // Create a mock request to trigger the daily summary
        const mockReq = new Request('http://localhost/api/reports/send-daily-summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        })
        const res = await app.fetch(mockReq, env, ctx)
        const result = await res.json()
        console.log('Daily summary result:', result)
      } catch (error) {
        console.error('Daily summary cron error:', error)
      }
    }
    
    // Follow-up reminders every 2 hours
    if (event.cron === '0 */2 * * *') {
      console.log('Sending follow-up reminders...')
      try {
        const mockReq = new Request('http://localhost/api/follow-ups/send-reminders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        })
        const res = await app.fetch(mockReq, env, ctx)
        const result = await res.json()
        console.log('Follow-up reminders result:', result)
      } catch (error) {
        console.error('Follow-up reminders cron error:', error)
      }
    }
  }
}