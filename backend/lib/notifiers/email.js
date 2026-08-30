/**
 * email.js — sends a lead notification over SMTP. Deliberately SMTP + app
 * password rather than the Gmail API + OAuth: OAuth needs a consent screen,
 * a refresh-token flow, and Google app verification for anything beyond
 * test users — way more setup than an education consultancy needs for
 * "email me when someone wants a callback." Gmail supports this directly:
 * a Google Account with 2FA turned on can generate an "app password" at
 * myaccount.google.com/apppasswords, which goes straight into config.pass.
 */
const nodemailer = require("nodemailer");

async function send(config, lead) {
  if (!config?.smtpHost || !config?.user || !config?.pass || !config?.to) {
    throw new Error("email notifier: missing smtpHost/user/pass/to in config");
  }

  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort || 465,
    secure: config.smtpPort !== 587, // 465 = implicit TLS, 587 = STARTTLS
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  });

  const lines = Object.entries(lead)
    .filter(([k]) => k !== "context")
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  await transporter.sendMail({
    from: config.from || config.user,
    to: config.to,
    subject: `New lead — ${lead.tenantId}`,
    text: `A visitor asked to be contacted.\n\n${lines}`,
  });
}

module.exports = { send };
