import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { Public } from "../auth/public.decorator";
import { InternalAuthGuard } from "../internal/internal-auth.guard";
import { CreateUserDto } from "./dto/create-user.dto";
import { UsersService } from "./users.service";

@ApiTags("users")
@Public()
@UseGuards(InternalAuthGuard)
@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({
    summary: "List users",
    description: "Internal endpoint for listing global user records.",
  })
  @ApiOkResponse({
    description: "Global users returned.",
  })
  @ApiUnauthorizedResponse({
    description: "A valid internal worker token is required.",
  })
  listUsers() {
    return this.usersService.listUsers();
  }

  @Post()
  @ApiOperation({
    summary: "Create user",
    description: "Internal endpoint for creating a global user record.",
  })
  @ApiCreatedResponse({
    description: "User created.",
  })
  @ApiUnauthorizedResponse({
    description: "A valid internal worker token is required.",
  })
  createUser(@Body() dto: CreateUserDto) {
    return this.usersService.createUser(dto);
  }
}
