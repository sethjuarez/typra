import "@typra/emitter";

namespace Typra.Fixtures.Features.PolymorphicReference;

@serializable
model Root {
  shape: Shape;
  shapes: Shape[];
  tree: TreeNode;
}

@discriminator("kind")
model Shape {
  kind: string;
  enabled: boolean = true;
  legacyLabel: string | null = null;
}

model Circle extends Shape {
  kind: "circle";
  radius: int32 = 3;
}

@discriminator("kind")
model TreeNode {
  kind: string;
}

model Branch extends TreeNode {
  kind: "branch";
  next?: TreeNode;
}
