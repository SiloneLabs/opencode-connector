export const fetchUserIdFromToken = async (
  token: string,
): Promise<string | null> => {
  // Local dev bypass
  if (token === "dev-token") return "dev-user";

  try {
    const res = await fetch(
      "https://instance-manager.silonelabs.workers.dev/api/v1/projects/verify-token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      },
    );

    if (!res.ok) return null;

    const json = (await res.json()) as {
      success: boolean;
      data?: { userId: string };
    };

    return json.success && json.data?.userId ? json.data.userId : null;
  } catch {
    return null;
  }
};
