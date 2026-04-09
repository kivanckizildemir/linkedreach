/**
 * CAPTCHA solver — wraps the 2captcha service.
 *
 * Used during LinkedIn headless reconnect when LinkedIn serves a
 * reCAPTCHA V2 challenge page (`d_checkpoint_ch_captchaV2Challenge`).
 *
 * Set TWOCAPTCHA_API_KEY in .env to enable. If the key is absent,
 * solveCaptcha returns null so the caller can fall back gracefully.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TwoCaptcha = require('2captcha')

/** Solve a reCAPTCHA V2 and return the g-recaptcha-response token. */
export async function solveRecaptchaV2(
  siteKey: string,
  pageUrl: string,
): Promise<string | null> {
  const apiKey = process.env.TWOCAPTCHA_API_KEY
  if (!apiKey) {
    console.warn('[captcha] TWOCAPTCHA_API_KEY not set — cannot solve captcha automatically')
    return null
  }

  try {
    const solver = new TwoCaptcha.Solver(apiKey)
    console.log(`[captcha] Submitting reCAPTCHA V2 to 2captcha (siteKey=${siteKey.substring(0, 12)}…)`)
    const result = await solver.recaptcha(siteKey, pageUrl)
    const token = result?.data as string | undefined
    if (!token) throw new Error('2captcha returned empty token')
    console.log(`[captcha] Got token (${token.substring(0, 20)}…)`)
    return token
  } catch (err) {
    console.error(`[captcha] 2captcha solve failed: ${(err as Error).message}`)
    return null
  }
}
