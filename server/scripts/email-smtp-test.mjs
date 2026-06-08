// Proves the nodemailer SMTP send path works end-to-end (the exact mechanism the
// app uses with Resend) — no custom domain needed. Uses Ethereal (a fake SMTP
// that captures the message and returns a viewable preview URL).
//
// Usage (from server/): node scripts/email-smtp-test.mjs
import nodemailer from 'nodemailer';

const acct = await nodemailer.createTestAccount();
const transport = nodemailer.createTransport({
  host: acct.smtp.host,
  port: acct.smtp.port,
  secure: acct.smtp.secure,
  auth: { user: acct.user, pass: acct.pass },
});

const info = await transport.sendMail({
  from: 'FarmFlow <no-reply@farmsteadflow.com>',
  to: 'farmer@example.com',
  subject: 'FarmFlow — SMTP проба',
  html: '<h1 style="color:#2d6a4f">🌿 FarmFlow</h1><p>Изпращането по SMTP работи.</p>',
  text: 'Изпращането по SMTP работи.',
});

console.log('OK messageId :', info.messageId);
console.log('accepted     :', JSON.stringify(info.accepted));
console.log('rejected     :', JSON.stringify(info.rejected));
console.log('response     :', info.response);
console.log('PREVIEW URL  :', nodemailer.getTestMessageUrl(info));
console.log('--- ethereal creds (to test the APP via .env) ---');
console.log('SMTP_HOST=' + acct.smtp.host);
console.log('SMTP_PORT=' + acct.smtp.port);
console.log('SMTP_USER=' + acct.user);
console.log('SMTP_PASS=' + acct.pass);
