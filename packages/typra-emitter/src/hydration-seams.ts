import { EmitContext, emitFile, resolvePath } from "@typespec/compiler";
import { ExportSurfaceSnapshot } from "./contract-surface.js";
import { TypraEmitterOptions } from "./lib.js";

export interface HydrationSeam {
  contract: string;
  target: string;
  group: string;
  symbol: string;
  generatedSource: string;
  seamKind: "protocol-adapter";
}

export interface HydrationBoundarySnapshot {
  emitter: "typra-emitter";
  version: 1;
  protectedPaths: string[];
  hydrationZones: string[];
  seams: HydrationSeam[];
}

export function buildHydrationBoundarySnapshot(
  exportSurface: ExportSurfaceSnapshot,
  options: Pick<TypraEmitterOptions, "protected-paths" | "hydration-zones">,
): HydrationBoundarySnapshot {
  return {
    emitter: "typra-emitter",
    version: 1,
    protectedPaths: uniqueSorted(options["protected-paths"] ?? []),
    hydrationZones: uniqueSorted(options["hydration-zones"] ?? []),
    seams: exportSurface.targets
      .flatMap((target) =>
        target.protocols.map((protocol) => ({
          contract: protocol.name,
          target: target.target,
          group: protocol.group,
          symbol: protocol.symbol,
          generatedSource: protocol.source,
          seamKind: "protocol-adapter" as const,
        })),
      )
      .sort((left, right) => seamKey(left).localeCompare(seamKey(right))),
  };
}

export async function emitHydrationBoundarySnapshot(
  context: EmitContext<TypraEmitterOptions>,
  snapshot: HydrationBoundarySnapshot,
): Promise<void> {
  await emitFile(context.program, {
    path: resolvePath(context.emitterOutputDir, ".typra-generated", "hydration-seams.json"),
    content: `${JSON.stringify(snapshot, null, 2)}\n`,
  });
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function seamKey(seam: HydrationSeam): string {
  return `${seam.target}:${seam.group}:${seam.contract}:${seam.symbol}`;
}
