# Privacy Policy

**Effective date:** 2026-05-15

## Scope

This application (`idiom-app`) is a personal, single-recipient SMS
notification tool. The sole end user is the developer/owner of the
application. There are no third-party recipients, no customer accounts,
and no shared user base.

## Information collected

The application processes only the following data:

- **Recipient phone number** — a single E.164 phone number supplied by
  the owner via the application's environment configuration
  (`TWILIO_TO_NUMBER`). This number is not collected from any external
  party; it is the owner's own number.
- **Inbound message text** — freeform replies the owner sends to the
  application's Twilio number. These are processed by an LLM to update
  the owner's taste profile and are stored in the application's
  Cloudflare D1 database.
- **Outbound message text** — Spanish-language idiom and colloquialism
  phrases generated for daily delivery, stored in the same D1 database
  for deduplication purposes.

## Sharing

The application does **not** share, sell, rent, or otherwise transfer
mobile numbers or message content to third parties for marketing or
promotional purposes. Mobile information is not shared with third
parties or affiliates for marketing or promotional purposes.

The application transmits data to the following processors strictly to
deliver its functionality:

- **Twilio** — to deliver SMS messages to the configured recipient.
- **Anthropic** — to generate phrase candidates and parse inbound replies.
- **Cloudflare** — to host the Worker and the D1 database.

## Message frequency

The application sends approximately **one (1) message per day** to the
configured recipient.

## Message and data rates

Standard message and data rates may apply.

## Opt-out

Reply `STOP` to the application's Twilio number at any time to
unsubscribe. Reply `HELP` for help information.

## Contact

For any questions about this policy, contact the application owner at
the email associated with the Twilio account.

## Source

The full source code for this application is publicly available at
https://github.com/userkaranb/idiom-app.
