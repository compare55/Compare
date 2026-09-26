# Telegram deposit approval

When a user submits an Add Money request, the server creates a PENDING deposit and sends the request to Telegram with **APPROVE** and **REJECT** buttons.

## Render Environment Variables

- `DATABASE_URL` = your PostgreSQL connection string
- `ADMIN_KEY` = your existing admin-panel key
- `TELEGRAM_BOT_TOKEN` = token from BotFather
- `TELEGRAM_CHAT_ID` = chat where deposit alerts should be sent (for your personal chat, this can be `6930997805`)
- `TELEGRAM_ADMIN_ID` = Telegram numeric ID allowed to press the approval buttons. Set this to `6930997805`.

Do **not** put the bot token in the frontend, GitHub, or ZIP.

## Approval flow

User submits amount + UTR -> deposit is PENDING -> Telegram notification appears -> authorized admin presses APPROVE or REJECT -> server updates the deposit atomically -> APPROVE credits the user's wallet; REJECT does not.

The server uses Telegram long polling, so no public Telegram webhook URL is required. Run only one Render instance of this service for Telegram polling.
