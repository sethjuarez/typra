import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { Namespace } from "@typespec/compiler";
import { createTestHost } from "@typespec/compiler/testing";

import { lowerTypeSpecTransportContracts } from "../src/ir/transport.js";

const require = createRequire(import.meta.url);

describe("transport-contract IR", () => {
  it("lowers official TypeSpec HTTP route metadata onto callable contracts", async () => {
    const httpPackageRoot = path.resolve(
      path.dirname(require.resolve("@typespec/http")),
      "..",
      "..",
    );
    const host = await createTestHost();
    await host.addTypeSpecLibrary({
      name: "@typespec/http",
      packageRoot: httpPackageRoot,
      files: [
        {
          realDir: ".",
          pattern: "package.json",
          virtualPath: "./node_modules/@typespec/http",
        },
        {
          realDir: path.join(httpPackageRoot, "lib"),
          pattern: "**/*.tsp",
          virtualPath: "./node_modules/@typespec/http/lib",
        },
        {
          realDir: path.join(httpPackageRoot, "dist", "src"),
          pattern: "**/*.js",
          virtualPath: "./node_modules/@typespec/http/dist/src",
        },
        {
          realDir: path.join(httpPackageRoot, "dist", "generated-defs"),
          pattern: "**/*.js",
          virtualPath: "./node_modules/@typespec/http/dist/generated-defs",
        },
      ],
    });
    await host.addTypeSpecFile(
      "main.tsp",
      `
      import "@typespec/http";
      using TypeSpec.Http;

      namespace Typra.HttpProbe;

      model Pet {
        name: string;
      }

      model UpdatePetRequest {
        name: string;
      }

      @route("/pets")
      interface Pets {
        @get
        @route("/{pet-id}")
        read(@path("pet-id") petId: string, @query("include-details") includeDetails?: boolean): Pet;

        @post
        @route("/{petId}")
        update(@path petId: string, @header contentVersion: string, @body request: UpdatePetRequest): Pet;
      }
    `,
    );
    await host.compile("main.tsp");
    const [namespace] = host.program.resolveTypeReference("Typra.HttpProbe");
    assert.equal(namespace?.kind, "Namespace");

    assert.deepEqual(
      lowerTypeSpecTransportContracts(
        host.program,
        namespace as Namespace,
        "Typra.HttpProbe",
        "HttpProbe",
      ),
      [
        {
          name: "Pets",
          namespace: "Typra.HttpProbe",
          callable: {
            name: "Pets",
            namespace: "Typra.HttpProbe",
            group: "",
            description: "",
            source: {
              kind: "typespec-interface",
              namespace: "Typra.HttpProbe",
              symbol: "Pets",
              group: "",
            },
            hydration: {
              seamKind: "protocol-adapter",
              implementation: "handwritten",
              generatedBoundary: "interface",
            },
            operations: [
              {
                name: "read",
                returns: "Pet",
                description: "",
                params: { petId: "string", includeDetails: "boolean" },
                optional: false,
                sync: false,
                runtimeCancellable: false,
                atomic: false,
                nonFatal: false,
                source: {
                  kind: "typespec-interface",
                  namespace: "Typra.HttpProbe",
                  symbol: "Pets",
                  group: "",
                },
              },
              {
                name: "update",
                returns: "Pet",
                description: "",
                params: {
                  petId: "string",
                  contentVersion: "string",
                  request: "UpdatePetRequest",
                },
                optional: false,
                sync: false,
                runtimeCancellable: false,
                atomic: false,
                nonFatal: false,
                source: {
                  kind: "typespec-interface",
                  namespace: "Typra.HttpProbe",
                  symbol: "Pets",
                  group: "",
                },
              },
            ],
          },
          operations: [
            {
              contract: "Pets",
              operation: "read",
              callable: {
                name: "read",
                returns: "Pet",
                description: "",
                params: { petId: "string", includeDetails: "boolean" },
                optional: false,
                sync: false,
                runtimeCancellable: false,
                atomic: false,
                nonFatal: false,
                source: {
                  kind: "typespec-interface",
                  namespace: "Typra.HttpProbe",
                  symbol: "Pets",
                  group: "",
                },
              },
              verb: "get",
              path: "/pets/{pet-id}",
              uriTemplate: "/pets/{pet-id}{?include%2Ddetails}",
              bindings: [
                {
                  name: "petId",
                  wireName: "pet-id",
                  type: "string",
                  kind: "path",
                  optional: false,
                },
                {
                  name: "includeDetails",
                  wireName: "include-details",
                  type: "boolean",
                  kind: "query",
                  optional: true,
                },
              ],
              responses: [
                {
                  statusCodes: ["200"],
                  body: "Pet",
                  contentTypes: ["application/json"],
                },
              ],
            },
            {
              contract: "Pets",
              operation: "update",
              callable: {
                name: "update",
                returns: "Pet",
                description: "",
                params: {
                  petId: "string",
                  contentVersion: "string",
                  request: "UpdatePetRequest",
                },
                optional: false,
                sync: false,
                runtimeCancellable: false,
                atomic: false,
                nonFatal: false,
                source: {
                  kind: "typespec-interface",
                  namespace: "Typra.HttpProbe",
                  symbol: "Pets",
                  group: "",
                },
              },
              verb: "post",
              path: "/pets/{petId}",
              uriTemplate: "/pets/{petId}",
              bindings: [
                {
                  name: "request",
                  wireName: "request",
                  type: "UpdatePetRequest",
                  kind: "body",
                  optional: false,
                },
                {
                  name: "contentVersion",
                  wireName: "content-version",
                  type: "string",
                  kind: "header",
                  optional: false,
                },
                {
                  name: "petId",
                  wireName: "petId",
                  type: "string",
                  kind: "path",
                  optional: false,
                },
              ],
              responses: [
                {
                  statusCodes: ["200"],
                  body: "Pet",
                  contentTypes: ["application/json"],
                },
              ],
            },
          ],
        },
      ],
    );
  });
});
