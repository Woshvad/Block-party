// What both entrypoints check before serving anyone. A missing bot token or a
// weak secret doesn't break the API visibly: it opens it (anyone could sign
// launch data, write room tickets or call internal routes). So the API
// refuses to run on any of these, and says which.

// A real token from @BotFather: the bot's numeric id, a colon, then 35
// letters, digits, - or _.
export const BOT_TOKEN = /^\d+:[A-Za-z0-9_-]{30,}$/;
// Every shared secret, like the signing code itself asks.
export const MIN_SECRET_LENGTH = 32;
// The placeholders in .env.example: long enough, but public.
const PLACEHOLDER = /replace-(me|with)/i;

export type SecretsEnv = {
  TELEGRAM_BOT_TOKEN?: string;
  INTERNAL_SECRET?: string;
  TICKET_SECRET?: string;
  RECEIPT_SECRET?: string;
};

// Each problem names the variable and the rule, never its value.
export function configProblems(env: SecretsEnv): string[] {
  const problems: string[] = [];
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) problems.push("TELEGRAM_BOT_TOKEN is not set");
  else if (!BOT_TOKEN.test(token) || PLACEHOLDER.test(token)) problems.push("TELEGRAM_BOT_TOKEN isn't a bot token (<bot id>:<30+ letters, digits, - or _>)");
  // INTERNAL_SECRET is always used; the others only once they're set.
  const secrets = [["INTERNAL_SECRET", env.INTERNAL_SECRET, true], ["TICKET_SECRET", env.TICKET_SECRET, false], ["RECEIPT_SECRET", env.RECEIPT_SECRET, false]] as const;
  for (const [name, value, required] of secrets) {
    if (!value) {
      if (required) problems.push(`${name} is not set`);
    } else if (value.length < MIN_SECRET_LENGTH) problems.push(`${name} must be ${MIN_SECRET_LENGTH}+ characters`);
    else if (PLACEHOLDER.test(value)) problems.push(`${name} is still the .env.example placeholder`);
  }
  return problems;
}
