// LinkedIn DOM selectors — centralised so breakage only needs one fix.
// LinkedIn regularly ships DOM changes; keep this file in sync.

export const SELECTORS = {
  // Profile page
  profile: {
    connectButton:     'button[aria-label*="Connect"]',
    messageButton:     'button[aria-label*="essage"]',
    followButton:      'button[aria-label*="Follow"]',
    // LinkedIn uses different aria-labels for the overflow menu across UI versions
    moreActionsButton: 'button[aria-label*="More"]',
    name:              'h1.text-heading-xlarge',
    connectionDegree:  '.distance-badge .dist-value',
  },

  // Connect dialog
  connect: {
    addNoteButton:   'button[aria-label="Add a note"]',
    noteTextarea:    '#custom-message',
    sendButton:      'button[aria-label="Send invitation"]',
    sendWithoutNote: 'button[aria-label="Send without a note"]',
  },

  // Messaging
  message: {
    composerTextarea: '.msg-form__contenteditable, [contenteditable="true"][role="textbox"]',
    sendButton:       'button.msg-form__send-button, button[aria-label="Send"], button[data-control-name="send"]',
    subjectInput:     '.msg-form__subject-field input',  // InMail
  },

  // Post reactions
  post: {
    likeButton:      'button[aria-label*="React Like"]',
    reactionTrigger: 'button.react-button__trigger',
    reactionOptions: {
      like:       'button[aria-label="Like"]',
      celebrate:  'button[aria-label="Celebrate"]',
      love:       'button[aria-label="Love"]',
      insightful: 'button[aria-label="Insightful"]',
      curious:    'button[aria-label="Curious"]',
    },
  },

  // Sales Navigator search
  salesNav: {
    resultItem:      'li.artdeco-list__item',
    personNameLink:  '[data-anonymize="person-name"]',
    title:           '[data-anonymize="title"]',
    company:         '[data-anonymize="company-name"]',
    location:        '[data-anonymize="location"]',
    degree:          '.dist-value',
    nextButton:      'button[aria-label="Next"]',
    noResults:       '.search-no-results',
    // On individual Sales Nav profile page
    linkedinUrl:     'a[href*="linkedin.com/in/"]',
    memberBadge:     '.profile-topcard-person-entity__degree-distance',
  },

  // Captcha / security
  security: {
    captchaFrame: 'iframe[src*="challenge"]',
    pinChallenge: 'input#input__email_verification_pin',
    checkpoint:   'section.error-container',
  },
}
