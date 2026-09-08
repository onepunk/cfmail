// Keep the iframe and response CSP in sync. Opened sites need their own
// browsing context so unsubscribe forms can work outside the message sandbox.
export const EMAIL_VIEWER_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";
