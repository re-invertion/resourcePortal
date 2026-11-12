-- All fixtures use random-looking fixed test UUIDs, never real user data.
BEGIN;
INSERT INTO "User" ("id","email","displayName","status","updatedAt") VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','owner-iam430@example.test','Existing RP Owner','Active',now()),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','app-iam430@example.test','Existing App User','Active',now()),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','role-free-iam430@example.test','No Privileges','Active',now());
INSERT INTO "UserIdentity" ("id","userId","providerType","issuer","externalSubject","email") VALUES
 ('aaaabbbb-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','zitadel','https://auth.example.test','10001','common-identity@example.test'),
 ('aaaabbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','zitadel','https://auth.example.test','10002','common-identity@example.test'),
 ('aaaabbbb-cccc-4ccc-8ccc-cccccccccccc','cccccccc-cccc-4ccc-8ccc-cccccccccccc','zitadel','https://auth.example.test','10003','other@example.test');
INSERT INTO "Tenant" ("id","name","displayName","status","contactEmail","updatedAt") VALUES
 ('11111111-1111-4111-8111-111111111111','test-iam430-a','Legacy Tenant A','Active','owner-iam430@example.test',now()),
 ('22222222-2222-4222-8222-222222222222','test-iam430-b','Legacy Tenant B','Active','app-iam430@example.test',now());
INSERT INTO "TenantMembership" ("id","userId","tenantId","createdBy") VALUES
 ('33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
 ('44444444-4444-4444-8444-444444444444','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
 ('77777777-7777-4777-8777-777777777777','cccccccc-cccc-4ccc-8ccc-cccccccccccc','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
INSERT INTO "Role" ("id","name","permissions") VALUES ('tenant-owner','Owner',ARRAY['*']::text[]);
INSERT INTO "MembershipRole" ("membershipId","roleId") VALUES ('33333333-3333-4333-8333-333333333333','tenant-owner');
INSERT INTO "TenantOidcProvider" ("tenantId","zitadelProjectId","issuer","status","enabled","updatedAt") VALUES
 ('11111111-1111-4111-8111-111111111111','project-a','https://auth.example.test','Active',true,now()),
 ('22222222-2222-4222-8222-222222222222','project-b','https://auth.example.test','Active',true,now());
INSERT INTO "OAuthApplication" ("id","tenantId","name","type","zitadelApplicationId","zitadelProjectId","clientId","createdBy","updatedBy","updatedAt") VALUES
 ('aaaa1111-aaaa-4111-8111-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','Legacy HA','Web','rp-legacy-app-a','project-a','legacy-client-a','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',now()),
 ('aaaa2222-aaaa-4222-8222-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','Foreign project','Web','rp-legacy-app-wrong','wrong-project','legacy-client-wrong','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',now()),
 ('bbbb1111-bbbb-4111-8111-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','App B','Web','rp-legacy-app-b','project-b','legacy-client-b','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',now());
INSERT INTO "TenantAppConsumer" ("membershipId","tenantId","createdBy","updatedAt") VALUES
 ('44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',now());
INSERT INTO "TenantAppClientGrant" ("id","membershipId","tenantId","oauthApplicationId","createdBy","updatedBy","updatedAt") VALUES
 ('55555555-5555-4555-8555-555555555555','44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222','bbbb1111-bbbb-4111-8111-bbbbbbbbbbbb','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',now());
COMMIT;
