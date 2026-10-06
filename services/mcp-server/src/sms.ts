/**
 * sms.ts — send a text message through Telnyx Messaging.
 *
 * Uses the `env.TELNYX` binding (`[telnyx] binding = "TELNYX"` in func.toml),
 * a pre-authenticated Telnyx SDK client, so no API key appears in code.
 * The sender is an alphanumeric ID (SMS_FROM, e.g. "FlyTLV") on the messaging
 * profile MESSAGING_PROFILE_ID: Telnyx Israeli numbers are voice-only.
 */

import { env } from "@telnyx/edge-runtime";

import { config } from "./config.js";

/** What the MCP server needs from an SMS provider (tests inject a fake). */
export interface SmsSender {
  send(to: string, text: string): Promise<void>;
}

/** The subset of the Telnyx SDK client used here. */
interface TelnyxMessages {
  messages: {
    send(body: { from: string; to: string; text: string; messaging_profile_id: string }): Promise<unknown>;
  };
}

export class TelnyxSms implements SmsSender {
  async send(to: string, text: string): Promise<void> {
    const client = (env as unknown as { TELNYX: TelnyxMessages }).TELNYX;
    await client.messages.send({
      from: config.require("SMS_FROM"),
      to,
      text,
      messaging_profile_id: config.require("MESSAGING_PROFILE_ID"),
    });
  }
}
