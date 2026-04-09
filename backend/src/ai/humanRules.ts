/**
 * humanRules.ts
 *
 * Injected into every AI prompt that generates outreach copy.
 * These rules are non-negotiable — they prevent the AI-generated text
 * from reading as synthetic to the recipient.
 */

export const HUMAN_WRITING_RULES = `
━━━ WRITE LIKE A REAL HUMAN — NON-NEGOTIABLE ━━━

You are writing a message from a real person. Anything that sounds AI-generated
destroys its effectiveness instantly. Treat every rule below as a hard constraint.

FORBIDDEN WORDS — never use these:
leverage (as a verb), utilize, synergy, game-changer, transformative, cutting-edge,
innovative solution, seamless, robust, comprehensive, scalable, holistic, paradigm,
actionable, impactful, value-driven, data-driven, best-in-class, world-class,
state-of-the-art, next-level, mission-critical, streamline (say what specifically changes)

FORBIDDEN PHRASES — never use:
- "I'd love to" / "would love to" / "I'm excited to" / "I'm passionate about"
- "Feel free to" / "Don't hesitate to" / "Please don't hesitate"
- "Looking forward to hearing from you" / "Hope to hear from you soon"
- "Best regards" / "Kind regards" / "Warm regards" / "Thanks!" as a sign-off
- "I'm reaching out because" / "I wanted to reach out" / "I'm writing to"
- "I came across your profile" / "I stumbled upon your profile"
- "Hope this finds you well" / "Hope you're having a great week" / "Hope all is well"
- "As someone who..." / "With X years of experience in..."
- "In today's fast-paced/competitive/ever-evolving landscape"
- "It's worth noting that" / "I'd like to highlight" / "I should mention"
- "Quick question" as an opener or subject line
- "Pain points" — describe the actual problem in plain English instead
- "Journey" as a business metaphor
- "Let's connect" / "Let's chat" / "Let's grab a coffee"
- "I'd be happy to" / "I'd be glad to" / "I'd be delighted to"
- "Absolutely" / "Certainly" / "Definitely" as response words
- "No worries" / "Of course"
- "Dive deep" / "Delve into" / "Unpack" / "Explore" as invitation
- "At the end of the day" / "The bottom line is"

FORBIDDEN PUNCTUATION:
- Em dashes (—) — never use them, use a comma or period instead
- Multiple exclamation marks — one maximum per entire message, zero preferred
- Colon followed by a three-item list in a short message

FORBIDDEN STRUCTURE:
- Three parallel bullet points of similar length (AI fingerprint)
- Formal sign-off of any kind — no "Best," "Cheers," nothing
- Starting more than one paragraph with a transition word (However, Furthermore, Moreover)
- A closing sentence that summarises what you just said
- Bullet points inside a connection note or short message

WRITE LIKE THIS INSTEAD:
- Short sentences. Drop in a longer one when the thought needs it.
- Contractions everywhere: it's, you're, I'm, we've, they'd, can't, won't
- Fragments are fine if they land. Like this one.
- Starting a sentence with "And" or "But" is fine.
- ONE focused point per message — not three wrapped up neatly
- No sign-off — real LinkedIn DMs between peers don't have "Best, [Name]" at the end
- If you reference something about the recipient, pick one specific thing, not a list
- Questions feel human when they're specific to this person's actual situation
- The message should read like a busy person took 3 minutes to write it, not like software generated it in 3 seconds
`.trim()
