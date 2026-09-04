import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { StorageCommandRunnerService } from "./storage-command-runner.service";

@Injectable()
export class LocalFilesystemStorageAdapterService {
  constructor(
    private readonly config: ConfigService,
    private readonly commands: StorageCommandRunnerService,
  ) {}

  async validateLocal() {
    void this.config;
    void this.commands;
    throw new InternalServerErrorException("Local filesystem validation is not implemented");
  }
}
