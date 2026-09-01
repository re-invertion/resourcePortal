export async function prepareStage20PlatformAdmin({
  prisma,
  state,
  zitadelOrigin,
}) {
  const adminUserId = requireEnv("FEDERATION_E2E_ADMIN_USER_ID");

  return prisma.$transaction(async (tx) => {
    const adminUser = await tx.user.findUnique({
      where: { id: adminUserId },
      select: { id: true },
    });
    assert(adminUser, `Platform admin user ${adminUserId} was not seeded`);

    const identity = await tx.userIdentity.findFirst({
      where: {
        issuer: zitadelOrigin,
        identityProviderId: state.oidcProviderId,
        email: state.oidcUser.email,
      },
    });
    assert(
      identity,
      "Stage 20 platform-admin fixture requires the successful live tenant OIDC login to run first",
    );

    if (identity.userId === adminUserId) return identity;

    const sourceUserId = identity.userId;
    const rebound = await tx.userIdentity.update({
      where: { id: identity.id },
      data: { userId: adminUserId },
    });

    await tx.user.delete({ where: { id: sourceUserId } });
    return rebound;
  });
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
