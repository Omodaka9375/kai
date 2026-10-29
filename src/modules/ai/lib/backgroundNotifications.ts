import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

/** Best-effort desktop notification for a session the user is not watching.
 *  Permission prompts happen only when an actual background event occurs. */
export async function notifyBackgroundAgent(
  projectName: string,
  body: string,
): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === "granted";
    }
    if (!granted) return;
    sendNotification({ title: `${projectName} · KAI`, body });
  } catch {
    // OS notifications are optional; never interrupt an agent run.
  }
}
