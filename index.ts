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