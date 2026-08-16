export type UpdateRequiredCapabilities = Readonly<{
  canRequestUpdate: true;
  canSignOut: true;
  canEraseLocalData: true;
  canReadMemberData: false;
  canMutateMemberData: false;
}>;

export function updateRequiredCapabilities(): UpdateRequiredCapabilities {
  return {
    canRequestUpdate: true,
    canSignOut: true,
    canEraseLocalData: true,
    canReadMemberData: false,
    canMutateMemberData: false,
  };
}
