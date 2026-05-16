// Web build of the local-notification helpers.
//
// The web app does not schedule local notifications. Metro resolves these
// no-ops over limitNotifications.ts for the web bundle.

export async function scheduleDailyResetNotification(): Promise<void> {
  // no-op on web
}

export async function cancelDailyResetNotification(): Promise<void> {
  // no-op on web
}
