import sgMail from "@sendgrid/mail";
import type { Logger } from "pino";

export interface EmailConfig {
  apiKey?: string;
  fromEmail?: string;
  logger?: Logger;
}

export interface SendEmailInput {
  to: string;
  template: "welcome" | "password_reset";
  data: Record<string, string>;
}

const templates: Record<string, { subject: string; html: string }> = {
  welcome: {
    subject: "Welcome to VaultQuest",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #4F46E5;">Welcome to VaultQuest!</h1>
        <p>Thank you for joining VaultQuest. We're excited to have you on board.</p>
        <p>With VaultQuest, you can:</p>
        <ul>
          <li>Create and manage savings vaults</li>
          <li>Participate in quest challenges</li>
          <li>Earn rewards through DeFi participation</li>
        </ul>
        <p>If you have any questions, feel free to reach out to our support team.</p>
        <p style="color: #6B7280; font-size: 12px;">This email was sent to {{email}}.</p>
      </div>
    `
  },
  password_reset: {
    subject: "Reset Your Password",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #4F46E5;">Password Reset Request</h1>
        <p>We received a request to reset your password.</p>
        <p>Click the link below to reset your password. This link will expire in 1 hour.</p>
        <a href="{{resetUrl}}" style="display: inline-block; background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 16px 0;">Reset Password</a>
        <p>If you did not request a password reset, please ignore this email.</p>
        <p style="color: #6B7280; font-size: 12px;">This email was sent to {{email}}.</p>
      </div>
    `
  }
};

export class EmailService {
  private readonly apiKey?: string;
  private readonly fromEmail: string;
  private readonly logger?: Logger;
  private readonly initialized: boolean;

  constructor(config: EmailConfig) {
    this.apiKey = config.apiKey;
    this.fromEmail = config.fromEmail || "noreply@vaultquest.io";
    this.logger = config.logger;
    this.initialized = !!config.apiKey;

    if (this.initialized) {
      sgMail.setApiKey(config.apiKey!);
    }
  }

  async sendEmail(input: SendEmailInput): Promise<boolean> {
    if (!this.initialized) {
      this.logger?.warn("EmailService not configured, skipping send");
      return false;
    }

    const template = templates[input.template];
    if (!template) {
      this.logger?.error({ template: input.template }, "Unknown email template");
      return false;
    }

    let html = template.html;
    for (const [key, value] of Object.entries(input.data)) {
      html = html.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    try {
      await sgMail.send({
        to: input.to,
        from: this.fromEmail,
        subject: template.subject,
        html
      });
      this.logger?.info({ to: input.to, template: input.template }, "Email sent successfully");
      return true;
    } catch (error) {
      this.logger?.error({ err: error, to: input.to, template: input.template }, "Failed to send email");
      return false;
    }
  }

  async sendWelcomeEmail(email: string, walletAddress: string): Promise<boolean> {
    return this.sendEmail({
      to: email,
      template: "welcome",
      data: { email, walletAddress }
    });
  }

  async sendPasswordResetEmail(email: string, resetToken: string): Promise<boolean> {
    const resetUrl = `https://vaultquest.io/reset-password?token=${resetToken}`;
    return this.sendEmail({
      to: email,
      template: "password_reset",
      data: { email, resetUrl }
    });
  }
}
