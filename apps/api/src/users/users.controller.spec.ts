import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { UserStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InternalAuthGuard } from "../internal/internal-auth.guard";
import { CreateUserDto } from "./dto/create-user.dto";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

function createConfig() {
  return {
    get: <T = string>(key: string, defaultValue?: T) =>
      (key === "INTERNAL_WORKER_TOKEN" ? "internal-token" : defaultValue) as T,
  } as ConfigService;
}

describe("UsersController RBAC", () => {
  let app: NestFastifyApplication;
  let usersService: {
    createUser: ReturnType<typeof vi.fn>;
    listUsers: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    usersService = {
      createUser: vi.fn().mockResolvedValue({
        id: "user-1",
        email: "user@example.com",
        displayName: "Example User",
        status: UserStatus.Active,
      }),
      listUsers: vi.fn().mockResolvedValue([
        {
          id: "user-1",
          email: "user@example.com",
          displayName: "Example User",
          status: UserStatus.Active,
        },
      ]),
    };

    Reflect.defineMetadata(
      "design:paramtypes",
      [UsersService],
      UsersController,
    );
    Reflect.defineMetadata(
      "design:paramtypes",
      [ConfigService],
      InternalAuthGuard,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        InternalAuthGuard,
        {
          provide: ConfigService,
          useValue: createConfig(),
        },
        {
          provide: UsersService,
          useValue: usersService,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix("api");
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("rejects anonymous user listing", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/users",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      message: "Invalid internal token",
    });
    expect(usersService.listUsers).not.toHaveBeenCalled();
  });

  it("allows user listing with the internal token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: {
        "x-internal-token": "internal-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        id: "user-1",
        email: "user@example.com",
        displayName: "Example User",
        status: UserStatus.Active,
      },
    ]);
  });

  it("allows user creation with the internal token", async () => {
    const dto: CreateUserDto = {
      displayName: "Example User",
      email: "user@example.com",
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: {
        "content-type": "application/json",
        "x-internal-token": "internal-token",
      },
      payload: dto,
    });

    expect(response.statusCode).toBe(201);
    expect(usersService.createUser).toHaveBeenCalledWith(dto);
  });
});
