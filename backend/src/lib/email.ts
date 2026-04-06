/**
 * Email notifications via Resend.
 * Set RESEND_API_KEY in env to enable. If not set, notifications are silently skipped.
 */

import { Resend } from 'resend'

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
const FROM = process.env.NOTIFICATION_FROM_EMAIL ?? 'LinkedReach <notifications@linkedreach.app>'

export async function sendReplyNotification(opts: {
  toEmail: string
  leadName: string
  leadLinkedinUrl: string
  messageSnippet: string
  campaignName: string
}): Promise<void> {
  if (!resend) return // silently skip if not configured

  const { toEmail, leadName, leadLinkedinUrl, messageSnippet, campaignName } = opts

  await resend.emails.send({
    from: FROM,
    to: toEmail,
    subject: `💬 New reply from ${leadName} — ${campaignName}`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827;">
        <h2 style="margin:0 0 16px;font-size:20px;">New reply from <strong>${leadName}</strong></h2>
        <div style="background:#f3f4f6;border-radius:8px;padding:16px;margin-bottom:20px;font-size:15px;line-height:1.6;color:#374151;">
          "${messageSnippet.length > 300 ? messageSnippet.slice(0, 300) + '…' : messageSnippet}"
        </div>
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Campaign: <strong>${campaignName}</strong></p>
        <div style="margin-top:24px;display:flex;gap:12px;">
          <a href="${leadLinkedinUrl}" style="display:inline-block;padding:10px 18px;background:#0a66c2;color:#fff;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;">
            View on LinkedIn
          </a>
          <a href="${process.env.APP_URL ?? 'https://linkedreach.netlify.app'}/inbox" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;">
            Open Inbox
          </a>
        </div>
        <p style="margin-top:32px;font-size:11px;color:#9ca3af;">
          You're receiving this because you have active campaigns in LinkedReach.<br/>
          To stop these emails, disable notifications in your account settings.
        </p>
      </div>
    `,
  })
}
