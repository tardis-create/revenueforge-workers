import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { Resend } from 'resend'
import { SignJWT, jwtVerify } from 'jose'
import bcrypt from 'bcryptjs'

type Bindings = {
  DB: D1Database
  JWT_SECRET: string
  RESEND_API_KEY: string
  RESEND_FROM_EMAIL: string
  TWILIO_ACCOUNT_SID: string
  TWILIO_AUTH_TOKEN: string
  TWILIO_PHONE_NUMBER: string
  NOTIFICATION_EMAIL_TO: string
  ADMIN_WHATSAPP_NUMBER: string
}

const app = new Hono<{ Bindings: Bindings }>()

// Enable CORS for frontend
app.use('*', cors({
  origin: [
    'https://revenueforge.pages.dev',
    'http://localhost:3000',
    'http://localhost:3001',
  ],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Cookie'],
  exposeHeaders: ['Set-Cookie'],
  credentials: true,
}))

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

// Products
app.get('/api/products', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT * FROM products ORDER BY created_at DESC').all()
    return c.json({ success: true, data: results })
  } catch (error) {
    return c.json({ error: 'Failed to fetch products' }, 500)
  }
})

app.post('/api/products', async (c) => {
  try {
    const body = await c.req.json()
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    await c.env.DB.prepare(
      'INSERT INTO products (id, name, sku, category, industry, description, technical_specs, price_range, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)'
    ).bind(id, body.name, body.sku, body.category, body.industry, body.description, JSON.stringify(body.technical_specs), body.price_range, now).run()
    return c.json({ success: true, id })
  } catch (error) {
    return c.json({ error: 'Failed to create product' }, 500)
  }
})

// ============ RFQ ROUTES ============

// POST /api/rfq - Create RFQ (public endpoint, no auth required)
app.post('/api/rfq', async (c) => {
  try {
    const body = await c.req.json()
    
    // Validation: company, contact, email required
    if (!body.company_name || !body.company_name.trim()) {
      return c.json({ error: 'Company name is required' }, 400)
    }
    if (!body.contact_name || !body.contact_name.trim()) {
      return c.json({ error: 'Contact name is required' }, 400)
    }
    if (!body.email || !body.email.trim()) {
      return c.json({ error: 'Email is required' }, 400)
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(body.email)) {
      return c.json({ error: 'Invalid email format' }, 400)
    }
    
    const rfqId = crypto.randomUUID()
    const now = new Date().toISOString()
    
    // Auto-create lead from RFQ submission (RF-B03 integration)
    let leadId: string | null = null
    try {
      leadId = crypto.randomUUID()
      let estimatedValue = 0
      
      // Parse estimated budget to numeric value
      if (body.estimated_budget) {
        const budgetStr = String(body.estimated_budget).replace(/[^0-9.-]/g, '')
        estimatedValue = parseFloat(budgetStr) || 0
      }
      
      // Create lead from RFQ
      await c.env.DB.prepare(`
        INSERT INTO leads (
          id, company_name, contact_name, email, phone, 
          status, source, estimated_value, notes, 
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        leadId,
        body.company_name.trim(),
        body.contact_name.trim(),
        body.email.toLowerCase().trim(),
        body.phone || null,
        'new',
        'rfq',
        estimatedValue,
        body.project_description || null,
        now,
        now
      ).run()
      
      // Create initial lead activity
      await c.env.DB.prepare(`
        INSERT INTO lead_activities (id, lead_id, type, description, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        leadId,
        'created',
        'Lead auto-created from RFQ submission',
        now
      ).run()
    } catch (leadError) {
      console.error('Failed to create lead from RFQ:', leadError)
      // Continue even if lead creation fails - RFQ is still valid
      leadId = null
    }
    
    // Create RFQ submission with lead link
    await c.env.DB.prepare(
      'INSERT INTO rfq_submissions (id, company_name, contact_name, email, phone, service_type, project_description, estimated_budget, timeline, status, notes, lead_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      rfqId, 
      body.company_name.trim(), 
      body.contact_name.trim(), 
      body.email.toLowerCase().trim(), 
      body.phone || null, 
      body.service_type || null, 
      body.project_description || null, 
      body.estimated_budget || null, 
      body.timeline || null, 
      'new', 
      body.additional_notes || null,
      leadId,
      now, 
      now
    ).run()

    // Send confirmation email to customer (non-blocking)
    if (body.email) {
      const emailHtml = `
        <h2>RFQ Received - Thank You!</h2>
        <p>Dear ${body.contact_name},</p>
        <p>We have received your Request for Quote. Our team will review your requirements and get back to you within 24-48 hours.</p>
        <h3>RFQ Details:</h3>
        <ul>
          <li><strong>Company:</strong> ${body.company_name}</li>
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
      ).catch(err => console.error('Failed to send confirmation email:', err))
    }

    // Send notification email to admin (non-blocking)
    if (c.env.NOTIFICATION_EMAIL_TO) {
      const adminHtml = `
        <h2>New RFQ Submitted</h2>
        <p>A new RFQ has been submitted and requires your attention.</p>
        <h3>Details:</h3>
        <ul>
          <li><strong>RFQ ID:</strong> ${rfqId}</li>
          ${leadId ? `<li><strong>Lead ID:</strong> ${leadId}</li>` : ''}
          <li><strong>Company:</strong> ${body.company_name}</li>
          <li><strong>Contact:</strong> ${body.contact_name}</li>
          <li><strong>Email:</strong> ${body.email}</li>
          <li><strong>Phone:</strong> ${body.phone || 'N/A'}</li>
          <li><strong>Service Type:</strong> ${body.service_type || 'N/A'}</li>
          <li><strong>Budget:</strong> ${body.estimated_budget || 'Not specified'}</li>
          <li><strong>Timeline:</strong> ${body.timeline || 'Not specified'}</li>
        </ul>
        <h3>Project Description:</h3>
        <p>${body.project_description || 'No description provided'}</p>
        ${leadId ? '<p><strong>Note:</strong> A new lead has been automatically created from this RFQ.</p>' : ''}
        <p><a href="https://revenueforge.pronitopenclaw.workers.dev/admin/rfq">View in Dashboard</a></p>
      `
      
      await sendEmail(
        c.env,
        c.env.NOTIFICATION_EMAIL_TO,
        `New RFQ: ${body.company_name} - ${body.service_type || 'General'}`,
        adminHtml
      ).catch(err => console.error('Failed to send admin notification:', err))
    }

    return c.json({ 
      success: true, 
      id: rfqId, 
      lead_id: leadId,
      message: 'RFQ submitted successfully' 
    }, 201)
  } catch (error) {
    console.error('RFQ error:', error)
    return c.json({ error: 'Failed to submit RFQ' }, 500)
  }
})

// GET /api/rfq - Paginated list of RFQs (auth required, admin only)
app.get('/api/rfq', authMiddleware, async (c) => {
  try {
    const page = parseInt(c.req.query('page') || '1')
    const limit = parseInt(c.req.query('limit') || '50')
    const offset = (page - 1) * limit
    
    const status = c.req.query('status')
    const startDate = c.req.query('start_date')
    const endDate = c.req.query('end_date')
    const search = c.req.query('search')
    
    // Build query with filters
    let whereConditions: string[] = []
    let params: any[] = []
    
    if (status) {
      whereConditions.push('status = ?')
      params.push(status)
    }
    
    if (startDate) {
      whereConditions.push('created_at >= ?')
      params.push(startDate)
    }
    
    if (endDate) {
      whereConditions.push('created_at <= ?')
      params.push(endDate)
    }
    
    if (search) {
      whereConditions.push('(company_name LIKE ? OR contact_name LIKE ? OR email LIKE ?)')
      const searchTerm = `%${search}%`
      params.push(searchTerm, searchTerm, searchTerm)
    }
    
    const whereClause = whereConditions.length > 0 
      ? 'WHERE ' + whereConditions.join(' AND ')
      : ''
    
    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM rfq_submissions ${whereClause}`
    const countResult = await c.env.DB.prepare(countQuery).bind(...params).first() as any
    const total = countResult?.total || 0
    
    // Get paginated results
    const dataQuery = `SELECT * FROM rfq_submissions ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    const { results } = await c.env.DB.prepare(dataQuery).bind(...params, limit, offset).all()
    
    return c.json({
      success: true,
      data: results,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    })
  } catch (error) {
    console.error('Fetch RFQs error:', error)
    return c.json({ error: 'Failed to fetch RFQs' }, 500)
  }
})

// GET /api/rfq/:id - Single RFQ detail (auth required)
app.get('/api/rfq/:id', authMiddleware, async (c) => {
  try {
    const rfqId = c.req.param('id')
    
    // Get RFQ details
    const rfq = await c.env.DB.prepare(
      'SELECT * FROM rfq_submissions WHERE id = ?'
    ).bind(rfqId).first()
    
    if (!rfq) {
      return c.json({ error: 'RFQ not found' }, 404)
    }
    
    // Get associated lead if exists
    let lead = null
    if ((rfq as any).lead_id) {
      lead = await c.env.DB.prepare(
        'SELECT * FROM leads WHERE id = ?'
      ).bind((rfq as any).lead_id).first()
    }
    
    return c.json({
      success: true,
      rfq,
      lead
    })
  } catch (error) {
    console.error('Fetch RFQ error:', error)
    return c.json({ error: 'Failed to fetch RFQ' }, 500)
  }
})

// PATCH /api/rfq/:id - Update RFQ status (auth required)
app.patch('/api/rfq/:id', authMiddleware, async (c) => {
  try {
    const rfqId = c.req.param('id')
    const body = await c.req.json()
    
    // Check if RFQ exists
    const existing = await c.env.DB.prepare(
      'SELECT id, status, lead_id FROM rfq_submissions WHERE id = ?'
    ).bind(rfqId).first() as any
    
    if (!existing) {
      return c.json({ error: 'RFQ not found' }, 404)
    }
    
    const now = new Date().toISOString()
    const updates: string[] = []
    const values: any[] = []
    
    // Valid status transitions: new → reviewed → quoted → closed
    const validStatuses = ['new', 'reviewed', 'quoted', 'closed']
    
    if (body.status) {
      if (!validStatuses.includes(body.status)) {
        return c.json({ 
          error: `Invalid status. Valid statuses: ${validStatuses.join(', ')}` 
        }, 400)
      }
      updates.push('status = ?')
      values.push(body.status)
      
      // Update associated lead status when RFQ is closed
      if (body.status === 'closed' && existing.lead_id) {
        await c.env.DB.prepare(
          'UPDATE leads SET status = ?, updated_at = ? WHERE id = ?'
        ).bind('closed', now, existing.lead_id).run()
      }
    }
    
    // Allow updating notes
    if (body.notes !== undefined) {
      updates.push('notes = ?')
      values.push(body.notes)
    }
    
    if (updates.length === 0) {
      return c.json({ error: 'No valid fields to update' }, 400)
    }
    
    updates.push('updated_at = ?')
    values.push(now)
    values.push(rfqId)
    
    await c.env.DB.prepare(
      `UPDATE rfq_submissions SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...values).run()
    
    // Get updated RFQ
    const updated = await c.env.DB.prepare(
      'SELECT * FROM rfq_submissions WHERE id = ?'
    ).bind(rfqId).first()
    
    return c.json({
      success: true,
      message: 'RFQ updated successfully',
      rfq: updated
    })
  } catch (error) {
    console.error('Update RFQ error:', error)
    return c.json({ error: 'Failed to update RFQ' }, 500)
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

// ============ QUOTES ROUTES ============

// Helper: Generate unique quote number
async function generateQuoteNumber(db: D1Database): Promise<string> {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  
  // Get count of quotes this month
  const { results } = await db.prepare(`
    SELECT COUNT(*) as count FROM quotes 
    WHERE quote_number LIKE ?
  `).bind(`QT-${year}${month}-%`).all()
  
  const count = ((results?.[0] as any)?.count || 0) + 1
  return `QT-${year}${month}-${String(count).padStart(4, '0')}`
}

// Helper: Recalculate quote totals
async function recalculateQuoteTotals(db: D1Database, quoteId: string): Promise<void> {
  // Get all items for this quote
  const { results } = await db.prepare(
    'SELECT quantity, unit_price, discount, total FROM quote_items WHERE quote_id = ?'
  ).bind(quoteId).all()
  
  const items = results as Array<{ quantity: number; unit_price: number; discount: number; total: number }>
  
  // Calculate subtotal from items
  let subtotal = 0
  for (const item of items) {
    subtotal += (item.quantity * item.unit_price) - (item.discount || 0)
  }
  
  // Get quote-level discount and tax
  const quote = await db.prepare('SELECT discount, tax FROM quotes WHERE id = ?').bind(quoteId).first() as { discount: number; tax: number } | null
  
  const quoteDiscount = quote?.discount || 0
  const quoteTax = quote?.tax || 0
  
  // Calculate total
  const afterDiscount = subtotal - quoteDiscount
  const taxAmount = afterDiscount * (quoteTax / 100)
  const total = afterDiscount + taxAmount
  
  // Update quote
  await db.prepare(`
    UPDATE quotes SET subtotal = ?, total = ?, updated_at = ? WHERE id = ?
  `).bind(subtotal, total, new Date().toISOString(), quoteId).run()
}

// 1. GET /api/quotes - Paginated list with status filter
app.get('/api/quotes', async (c) => {
  try {
    const status = c.req.query('status')
    const page = parseInt(c.req.query('page') || '1')
    const limit = parseInt(c.req.query('limit') || '20')
    const offset = (page - 1) * limit
    
    let query = 'SELECT * FROM quotes WHERE 1=1'
    const params: any[] = []
    
    if (status) {
      query += ' AND status = ?'
      params.push(status)
    }
    
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
    params.push(limit, offset)
    
    const { results } = await c.env.DB.prepare(query).bind(...params).all()
    
    // Get total count for pagination
    let countQuery = 'SELECT COUNT(*) as total FROM quotes WHERE 1=1'
    const countParams: any[] = []
    if (status) {
      countQuery += ' AND status = ?'
      countParams.push(status)
    }
    const { results: countResult } = await c.env.DB.prepare(countQuery).bind(...countParams).all()
    const total = (countResult?.[0] as any)?.total || 0
    
    return c.json({
      quotes: results,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    })
  } catch (error) {
    console.error('Fetch quotes error:', error)
    return c.json({ error: 'Failed to fetch quotes' }, 500)
  }
})

// 2. GET /api/quotes/:id - Single quote with line items
app.get('/api/quotes/:id', async (c) => {
  try {
    const quoteId = c.req.param('id')
    
    const quote = await c.env.DB.prepare('SELECT * FROM quotes WHERE id = ?').bind(quoteId).first()
    if (!quote) {
      return c.json({ error: 'Quote not found' }, 404)
    }
    
    // Get line items
    const { results: items } = await c.env.DB.prepare(
      'SELECT * FROM quote_items WHERE quote_id = ? ORDER BY sort_order, created_at'
    ).bind(quoteId).all()
    
    return c.json({
      quote,
      items: items || []
    })
  } catch (error) {
    console.error('Fetch quote error:', error)
    return c.json({ error: 'Failed to fetch quote' }, 500)
  }
})

// 3. POST /api/quotes - Create quote with line items (returns 201)
app.post('/api/quotes', async (c) => {
  try {
    const body = await c.req.json()
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const quoteNumber = await generateQuoteNumber(c.env.DB)
    
    // Calculate initial totals from items
    let subtotal = 0
    const items = body.items || []
    for (const item of items) {
      const itemTotal = (item.quantity || 1) * (item.unit_price || 0) - (item.discount || 0)
      subtotal += itemTotal
    }
    
    const quoteDiscount = body.discount || 0
    const quoteTax = body.tax || 0
    const afterDiscount = subtotal - quoteDiscount
    const taxAmount = afterDiscount * (quoteTax / 100)
    const total = afterDiscount + taxAmount
    
    // Insert quote
    await c.env.DB.prepare(`
      INSERT INTO quotes (
        id, quote_number, rfq_id, lead_id, company_name, contact_name,
        email, phone, status, valid_until, notes, terms,
        subtotal, discount, tax, total, created_at, updated_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      quoteNumber,
      body.rfq_id || null,
      body.lead_id || null,
      body.company_name || null,
      body.contact_name || null,
      body.email || null,
      body.phone || null,
      body.status || 'draft',
      body.valid_until || null,
      body.notes || null,
      body.terms || null,
      subtotal,
      quoteDiscount,
      quoteTax,
      total,
      now,
      now,
      body.created_by || null
    ).run()
    
    // Insert line items
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const itemId = crypto.randomUUID()
      const itemTotal = (item.quantity || 1) * (item.unit_price || 0) - (item.discount || 0)
      
      await c.env.DB.prepare(`
        INSERT INTO quote_items (id, quote_id, description, quantity, unit_price, discount, total, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        itemId,
        id,
        item.description,
        item.quantity || 1,
        item.unit_price || 0,
        item.discount || 0,
        itemTotal,
        i,
        now
      ).run()
    }
    
    return c.json({
      success: true,
      id,
      quote_number: quoteNumber,
      message: 'Quote created successfully'
    }, 201)
  } catch (error) {
    console.error('Create quote error:', error)
    return c.json({ error: 'Failed to create quote' }, 500)
  }
})

// 4. POST /api/quotes/from-rfq/:rfq_id - Create quote pre-filled from RFQ
app.post('/api/quotes/from-rfq/:rfq_id', async (c) => {
  try {
    const rfqId = c.req.param('rfq_id')
    
    // Get RFQ details
    const rfq = await c.env.DB.prepare('SELECT * FROM rfq_submissions WHERE id = ?').bind(rfqId).first()
    if (!rfq) {
      return c.json({ error: 'RFQ not found' }, 404)
    }
    
    const body = await c.req.json().catch(() => ({}))
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const quoteNumber = await generateQuoteNumber(c.env.DB)
    
    // Create quote from RFQ data
    await c.env.DB.prepare(`
      INSERT INTO quotes (
        id, quote_number, rfq_id, lead_id, company_name, contact_name,
        email, phone, status, valid_until, notes, terms,
        subtotal, discount, tax, total, created_at, updated_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      quoteNumber,
      rfqId,
      (rfq as any).lead_id || null,
      (rfq as any).company_name || null,
      (rfq as any).contact_name || null,
      (rfq as any).email || null,
      (rfq as any).phone || null,
      'draft',
      body.valid_until || null,
      `Created from RFQ\n\nProject: ${(rfq as any).project_description || 'N/A'}\nBudget: ${(rfq as any).estimated_budget || 'N/A'}\nTimeline: ${(rfq as any).timeline || 'N/A'}`,
      body.terms || null,
      0, 0, 0, 0,
      now,
      now,
      body.created_by || null
    ).run()
    
    return c.json({
      success: true,
      id,
      quote_number: quoteNumber,
      message: 'Quote created from RFQ'
    }, 201)
  } catch (error) {
    console.error('Create quote from RFQ error:', error)
    return c.json({ error: 'Failed to create quote from RFQ' }, 500)
  }
})

// 5. PATCH /api/quotes/:id - Update quote details
app.patch('/api/quotes/:id', async (c) => {
  try {
    const quoteId = c.req.param('id')
    const body = await c.req.json()
    const now = new Date().toISOString()
    
    // Check if quote exists
    const existing = await c.env.DB.prepare('SELECT id FROM quotes WHERE id = ?').bind(quoteId).first()
    if (!existing) {
      return c.json({ error: 'Quote not found' }, 404)
    }
    
    // Build dynamic update query
    const updates: string[] = []
    const params: any[] = []
    
    const allowedFields = ['company_name', 'contact_name', 'email', 'phone', 'valid_until', 'notes', 'terms', 'discount', 'tax']
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates.push(`${field} = ?`)
        params.push(body[field])
      }
    }
    
    if (updates.length === 0) {
      return c.json({ error: 'No valid fields to update' }, 400)
    }
    
    updates.push('updated_at = ?')
    params.push(now)
    params.push(quoteId)
    
    await c.env.DB.prepare(
      `UPDATE quotes SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...params).run()
    
    // Recalculate totals if discount or tax changed
    if (body.discount !== undefined || body.tax !== undefined) {
      await recalculateQuoteTotals(c.env.DB, quoteId)
    }
    
    return c.json({ success: true, message: 'Quote updated' })
  } catch (error) {
    console.error('Update quote error:', error)
    return c.json({ error: 'Failed to update quote' }, 500)
  }
})

// 6. POST /api/quotes/:id/items - Add line item to quote
app.post('/api/quotes/:id/items', async (c) => {
  try {
    const quoteId = c.req.param('id')
    const body = await c.req.json()
    
    // Check if quote exists
    const existing = await c.env.DB.prepare('SELECT id FROM quotes WHERE id = ?').bind(quoteId).first()
    if (!existing) {
      return c.json({ error: 'Quote not found' }, 404)
    }
    
    if (!body.description) {
      return c.json({ error: 'Item description is required' }, 400)
    }
    
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const quantity = body.quantity || 1
    const unitPrice = body.unit_price || 0
    const discount = body.discount || 0
    const total = (quantity * unitPrice) - discount
    
    // Get max sort_order
    const { results } = await c.env.DB.prepare(
      'SELECT MAX(sort_order) as max_order FROM quote_items WHERE quote_id = ?'
    ).bind(quoteId).all()
    const sortOrder = ((results?.[0] as any)?.max_order || -1) + 1
    
    await c.env.DB.prepare(`
      INSERT INTO quote_items (id, quote_id, description, quantity, unit_price, discount, total, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, quoteId, body.description, quantity, unitPrice, discount, total, sortOrder, now).run()
    
    // Recalculate totals
    await recalculateQuoteTotals(c.env.DB, quoteId)
    
    return c.json({ success: true, id, message: 'Item added to quote' }, 201)
  } catch (error) {
    console.error('Add quote item error:', error)
    return c.json({ error: 'Failed to add item to quote' }, 500)
  }
})

// 7. DELETE /api/quotes/:id/items/:item_id - Remove line item
app.delete('/api/quotes/:id/items/:item_id', async (c) => {
  try {
    const quoteId = c.req.param('id')
    const itemId = c.req.param('item_id')
    
    // Check if quote and item exist
    const item = await c.env.DB.prepare(
      'SELECT id FROM quote_items WHERE id = ? AND quote_id = ?'
    ).bind(itemId, quoteId).first()
    
    if (!item) {
      return c.json({ error: 'Item not found' }, 404)
    }
    
    await c.env.DB.prepare('DELETE FROM quote_items WHERE id = ?').bind(itemId).run()
    
    // Recalculate totals
    await recalculateQuoteTotals(c.env.DB, quoteId)
    
    return c.json({ success: true, message: 'Item removed from quote' })
  } catch (error) {
    console.error('Delete quote item error:', error)
    return c.json({ error: 'Failed to remove item from quote' }, 500)
  }
})

// 8. PATCH /api/quotes/:id/status - Change quote status
app.patch('/api/quotes/:id/status', async (c) => {
  try {
    const quoteId = c.req.param('id')
    const body = await c.req.json()
    const now = new Date().toISOString()
    
    if (!body.status) {
      return c.json({ error: 'Status is required' }, 400)
    }
    
    const validStatuses = ['draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled']
    if (!validStatuses.includes(body.status)) {
      return c.json({ error: `Invalid status. Valid statuses: ${validStatuses.join(', ')}` }, 400)
    }
    
    // Check if quote exists
    const existing = await c.env.DB.prepare('SELECT id FROM quotes WHERE id = ?').bind(quoteId).first()
    if (!existing) {
      return c.json({ error: 'Quote not found' }, 404)
    }
    
    await c.env.DB.prepare(
      'UPDATE quotes SET status = ?, updated_at = ? WHERE id = ?'
    ).bind(body.status, now, quoteId).run()
    
    return c.json({ success: true, message: 'Quote status updated' })
  } catch (error) {
    console.error('Update quote status error:', error)
    return c.json({ error: 'Failed to update quote status' }, 500)
  }
})

// PATCH /api/quotes/:id/items/:item_id - Update line item
app.patch('/api/quotes/:id/items/:item_id', async (c) => {
  try {
    const quoteId = c.req.param('id')
    const itemId = c.req.param('item_id')
    const body = await c.req.json()
    
    // Check if item exists
    const item = await c.env.DB.prepare(
      'SELECT id FROM quote_items WHERE id = ? AND quote_id = ?'
    ).bind(itemId, quoteId).first()
    
    if (!item) {
      return c.json({ error: 'Item not found' }, 404)
    }
    
    const updates: string[] = []
    const params: any[] = []
    
    const allowedFields = ['description', 'quantity', 'unit_price', 'discount', 'sort_order']
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates.push(`${field} = ?`)
        params.push(body[field])
      }
    }
    
    if (updates.length === 0) {
      return c.json({ error: 'No valid fields to update' }, 400)
    }
    
    params.push(itemId)
    
    await c.env.DB.prepare(
      `UPDATE quote_items SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...params).run()
    
    // Recalculate item total and quote totals
    const quantity = body.quantity !== undefined ? body.quantity : 1
    const unitPrice = body.unit_price !== undefined ? body.unit_price : 0
    const discount = body.discount !== undefined ? body.discount : 0
    const total = (quantity * unitPrice) - discount
    
    await c.env.DB.prepare('UPDATE quote_items SET total = ? WHERE id = ?').bind(total, itemId).run()
    await recalculateQuoteTotals(c.env.DB, quoteId)
    
    return c.json({ success: true, message: 'Item updated' })
  } catch (error) {
    console.error('Update quote item error:', error)
    return c.json({ error: 'Failed to update item' }, 500)
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