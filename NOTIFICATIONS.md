# RevenueForge Notifications API

## Endpoints

### POST /api/notifications/send
Generic notification endpoint for email and WhatsApp messages.

**Request Body:**
```json
{
  "type": "email" | "whatsapp" | "rfq_confirmation" | "followup_reminder",
  "to": "recipient@example.com",
  "subject": "Optional subject",
  "message": "Plain text message",
  "html": "HTML content",
  "data": { ... } // Context data for templates
}
```

**Examples:**

#### Send Email:
```json
{
  "type": "email",
  "to": "customer@example.com",
  "subject": "Welcome",
  "html": "<h1>Welcome!</h1>"
}
```

#### Send WhatsApp:
```json
{
  "type": "whatsapp",
  "to": "+1234567890",
  "message": "Hello from RevenueForge!"
}
```

### POST /api/rfq
Submits an RFQ and automatically sends:
- Confirmation email to customer
- Notification email to admin

### GET /api/follow-ups/upcoming
Get upcoming follow-ups. Query params:
- `hours` - Number of hours to look ahead (default: 24)

### POST /api/follow-ups/send-reminders
Manually trigger WhatsApp reminders for upcoming follow-ups.

### GET /api/reports/daily-summary
Get daily summary of leads, RFQs, and follow-ups.

### POST /api/reports/send-daily-summary
Generate and email daily summary report.

## Cron Jobs

| Schedule | Endpoint | Description |
|----------|----------|-------------|
| 0 9 * * * | /api/reports/send-daily-summary | Daily summary email at 9 AM |
| 0 */2 * * * | /api/follow-ups/send-reminders | Follow-up reminders every 2 hours |

## Environment Variables

### Required
- `RESEND_API_KEY` - Resend API key for email
- `NOTIFICATION_EMAIL_TO` - Admin email for notifications

### Optional
- `RESEND_FROM_EMAIL` - From email address (default: notifications@revenueforge.com)
- `TWILIO_ACCOUNT_SID` - Twilio Account SID for WhatsApp
- `TWILIO_AUTH_TOKEN` - Twilio Auth Token
- `TWILIO_PHONE_NUMBER` - Twilio WhatsApp-enabled number
- `ADMIN_WHATSAPP_NUMBER` - Admin WhatsApp number for reminders

## Setup

1. Set secrets:
```bash
wrangler secret put RESEND_API_KEY
wrangler secret put TWILIO_ACCOUNT_SID
wrangler secret put TWILIO_AUTH_TOKEN
```

2. Deploy:
```bash
wrangler deploy
```