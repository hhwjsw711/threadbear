// Old runners save a pool's known fields only. Keep backup choices they
// couldn't read, while still taking an explicit true or false from new ones.
type Member = { provider: string; email?: string; runnerId?: string; accountId?: string; backup?: boolean };

export function keepBackupChoices<T extends Member>(members: T[], previous: Member[]): (T & Member)[] {
  return members.map((member) => {
    if (member.backup !== undefined) return member;
    const sameProvider = previous.filter((m) => m.provider === member.provider);
    const pinned = member.runnerId && member.accountId
      ? sameProvider.find((m) => m.runnerId === member.runnerId && m.accountId === member.accountId)
      : undefined;
    const byEmail = member.email ? sameProvider.filter((m) => m.email?.toLowerCase() === member.email?.toLowerCase()) : [];
    const before = pinned ?? (byEmail.length === 1 ? byEmail[0] : undefined);
    return before?.backup === undefined ? member : { ...member, backup: before.backup };
  });
}
