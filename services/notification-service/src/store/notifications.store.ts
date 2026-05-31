export type InAppNotification = {
  id: string;
  user_id: string;
  type: string;
  title: string;
  message: string;
  data?: Record<string, any>;
  created_at: string;
  read_at: string | null;
};

export const notificationStore = new Map<string, InAppNotification[]>();

export function createNotification(
  input: Omit<InAppNotification, 'id' | 'created_at' | 'read_at'>,
): InAppNotification {
  return {
    id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    created_at: new Date().toISOString(),
    read_at: null,
    ...input,
  };
}

export function pushNotification(notification: InAppNotification): void {
  const current = notificationStore.get(notification.user_id) ?? [];
  current.unshift(notification);
  notificationStore.set(notification.user_id, current.slice(0, 200));
}
