import { describe, expect, it } from "vitest";
import { validateSync } from "class-validator";
import { CreateSingleAppDto } from "./dto/create-single-app.dto";
import { UpdateSingleAppDto } from "./dto/update-single-app.dto";

// DTO validation also applies to direct create/update calls, not just YAML imports.
describe("tenant CPU allocation", () => {
  for (const Dto of [CreateSingleAppDto, UpdateSingleAppDto]) {
    it(`${Dto.name} rejects zero and sub-minimum CPU allocation`, () => {
      for (const cpu of [0, -0.1, 0.001]) {
        const dto = Object.assign(new Dto(), {
          name: "web", image: "nginx:latest", cpu, memoryBytes: 134217728,
        });
        expect(validateSync(dto).some((err) => err.property === "cpu")).toBe(true);
      }
      const dto = Object.assign(new Dto(), {
        name: "web", image: "nginx:latest", cpu: 0.01, memoryBytes: 134217728,
      });
      expect(validateSync(dto).filter((err) => err.property === "cpu")).toEqual([]);
    });
  }
});
