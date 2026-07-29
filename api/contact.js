// Vercel Serverless Function — POST /api/contact
// Validates the incoming contact form payload and sends it via Resend
// to the TrueNorth Financial inbox.

const { Resend } = require('resend');

const TO_EMAIL = 'jewelnme.001@gmail.com'; // Single source of truth for where leads land

// Resend's shared sandbox sender. Works with zero setup, but can ONLY
// reliably deliver to the email address your Resend account was created
// with — every other recipient may silently fail or land in spam.
//
// ACTION REQUIRED BEFORE RELYING ON THIS FORM IN PRODUCTION:
//   1. Verify a domain you own in the Resend dashboard (Domains > Add Domain).
//   2. Set the RESEND_FROM_EMAIL environment variable in Vercel to something
//      like "TrueNorth Financial <contact@truenorthfinancial.ca>".
//   3. Redeploy. Until then, leads may not reliably reach TO_EMAIL below.
const usingSandboxSender = !process.env.RESEND_FROM_EMAIL;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'TrueNorth Financial <onboarding@resend.dev>';
if (usingSandboxSender) {
  console.warn('[contact] RESEND_FROM_EMAIL is not set — using the Resend sandbox sender, ' +
    'which can silently fail to deliver to recipients outside your Resend account. ' +
    'Verify a domain in Resend and set RESEND_FROM_EMAIL before relying on this in production.');
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Best-effort in-memory rate limiting. Serverless instances are ephemeral and
// may be recycled or run in parallel, so this is a deterrent against basic
// abuse from a single warm instance, not a hard guarantee — pair it with the
// honeypot/timing checks below rather than relying on it alone. For strict
// guarantees across all instances, move this to a shared store (e.g. Upstash
// Redis / Vercel KV) keyed by IP.
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX = 5; // max submissions per IP per window
const submissionLog = new Map(); // ip -> array of timestamps

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (submissionLog.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  submissionLog.set(ip, timestamps);
  // Opportunistically trim the map so it doesn't grow unbounded on a long-lived instance.
  if (submissionLog.size > 5000) submissionLog.clear();
  return timestamps.length > RATE_LIMIT_MAX;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Trims a field, caps its length, and falls back for optional fields.
function cleanField(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 2000);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, message: 'Method not allowed.' });
  }

  if (!process.env.RESEND_API_KEY) {
    console.error('[contact] RESEND_API_KEY is not set in the environment.');
    return res.status(500).json({
      success: false,
      message: 'Email service is not configured yet. Please try again later.',
    });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .toString().split(',')[0].trim();
  if (isRateLimited(ip)) {
    console.warn(`[contact] Rate limit exceeded for ${ip}`);
    return res.status(429).json({
      success: false,
      message: 'Too many requests. Please wait a few minutes and try again.',
    });
  }

  // Vercel auto-parses JSON bodies into req.body, but guard against edge
  // cases where it arrives as a raw string (or is missing entirely).
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (parseErr) {
      return res.status(400).json({ success: false, message: 'Invalid request body.' });
    }
  }
  body = body && typeof body === 'object' ? body : {};

  // Honeypot: a field that's invisible and untabbable for real visitors.
  // Bots that blindly fill every input will trip this. Timing: real people
  // take at least ~1.5s to read and fill the form; instant submissions are
  // almost always scripted. Both cases return a fake success so scrapers
  // don't learn which signal caught them, without ever calling Resend.
  const honeypotTripped = typeof body.company_website === 'string' && body.company_website.trim() !== '';
  const elapsedMs = Number(body.elapsedMs);
  const tooFast = Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < 1500;
  if (honeypotTripped || tooFast) {
    console.warn(`[contact] Blocked likely-bot submission from ${ip} (honeypot=${honeypotTripped}, tooFast=${tooFast})`);
    return res.status(200).json({ success: true, message: 'Your request has been sent successfully.' });
  }

  const name = cleanField(body.name, '');
  const email = cleanField(body.email, '');
  const company = cleanField(body.company, 'Not provided');
  const country = cleanField(body.country, 'Not specified');
  const service = cleanField(body.service, 'Not specified');

  const fieldErrors = {};
  if (!name) fieldErrors.name = 'Please enter your full name.';
  if (!email) fieldErrors.email = 'Please enter your work email.';
  else if (!EMAIL_REGEX.test(email)) fieldErrors.email = 'Please enter a valid email address.';

  if (Object.keys(fieldErrors).length > 0) {
    return res.status(400).json({
      success: false,
      message: 'Please correct the highlighted fields and try again.',
      fieldErrors,
    });
  }

  const submittedAt = new Date().toISOString();

  try {
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: [TO_EMAIL],
      replyTo: email,
      subject: `New discovery call request from ${name}`,
      text: [
        'New discovery call request from true-north-chi.vercel.app',
        '',
        `Name: ${name}`,
        `Email: ${email}`,
        `Company: ${company}`,
        `Market: ${country}`,
        `Interested in: ${service}`,
        '',
        `Submitted: ${submittedAt}`,
      ].join('\n'),
      html: `
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a">
          <h2 style="margin:0 0 16px;font-size:18px">New discovery call request</h2>
          <p style="margin:0 0 8px"><strong>Name:</strong> ${escapeHtml(name)}</p>
          <p style="margin:0 0 8px"><strong>Email:</strong> ${escapeHtml(email)}</p>
          <p style="margin:0 0 8px"><strong>Company:</strong> ${escapeHtml(company)}</p>
          <p style="margin:0 0 8px"><strong>Market:</strong> ${escapeHtml(country)}</p>
          <p style="margin:0 0 8px"><strong>Interested in:</strong> ${escapeHtml(service)}</p>
          <p style="margin:20px 0 0;color:#666;font-size:12.5px">Submitted ${escapeHtml(submittedAt)} via true-north-chi.vercel.app</p>
        </div>
      `,
    });

    if (error) {
      console.error('[contact] Resend API error:', error);
      return res.status(500).json({
        success: false,
        message: 'We could not send your request right now. Please try again shortly or email us directly.',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Your request has been sent successfully.',
      id: data && data.id,
    });
  } catch (err) {
    console.error('[contact] Unexpected error sending contact email:', err);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong on our end. Please try again shortly.',
    });
  }
};
