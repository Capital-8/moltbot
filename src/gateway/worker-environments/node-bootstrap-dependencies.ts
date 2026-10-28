import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { valid } from "semver";
import { validateBundledPackageDependencyAlignment } from "../../../scripts/package-source-dependencies.mjs";
import { sha256File } from "../../infra/directory-durability.js";
import { hasErrnoCode } from "../../infra/errno.js";

export type DependencyManifest = {
  bundleDependencies?: string[];
  bundledDependencies?: string[];
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  os?: string[];
  cpu?: string[];
};

export type NodeBootstrapDependency = {
  requestedName: string;
  root: string;
  prefix: string;
  manifest: DependencyManifest;
};

async function resolveInstalledDependency(root: string, name: string): Promise<string | undefined> {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name)) {
    throw new Error(`Invalid node runtime dependency name: ${name}`);
  }
  for (let directory = root; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, "node_modules", name);
    try {
      return await fs.realpath(candidate);
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
    }
    if (directory === path.dirname(directory)) {
      return undefined;
    }
  }
}

/** Materialize Node's installed dependency graph, retaining nested version contexts without links. */
export async function collectNodeBootstrapDependencies(
  root: string,
  manifest: DependencyManifest,
  target: { platform: string; arch: string },
  dependencyRoots: readonly string[] = [],
): Promise<NodeBootstrapDependency[]> {
  const result: NodeBootstrapDependency[] = [];
  const rootPlacements = new Map<string, string>();
  const visit = async (
    source: string,
    parent: DependencyManifest,
    prefix: string,
    ancestors: readonly ReadonlyMap<string, string>[],
  ): Promise<void> => {
    const dependencies = {
      ...parent.peerDependencies,
      ...parent.dependencies,
      ...parent.optionalDependencies,
    };
    const children: Array<
      NodeBootstrapDependency & { ancestors: readonly ReadonlyMap<string, string>[] }
    > = [];
    const placements = new Map<string, string>();
    for (const [name, spec] of Object.entries(dependencies).toSorted(([a], [b]) =>
      a.localeCompare(b),
    )) {
      // A plugin's OpenClaw peer is its enclosing runtime, not another installation.
      if (name === manifest.name) {
        continue;
      }
      const optional =
        name in (parent.optionalDependencies ?? {}) ||
        parent.peerDependenciesMeta?.[name]?.optional === true;
      let installed = await resolveInstalledDependency(source, name);
      if (!installed && !prefix) {
        for (const dependencyRoot of dependencyRoots) {
          installed ??= await resolveInstalledDependency(dependencyRoot, name);
        }
      }
      if (!installed) {
        if (optional) {
          continue;
        }
        throw new Error(
          `Node runtime dependency is not installed: ${parent.name} requires ${name}`,
        );
      }
      const value = JSON.parse(
        await fs.readFile(path.join(installed, "package.json"), "utf8"),
      ) as DependencyManifest;
      // The frozen-lock install owns transitive overrides and peer resolution. Preserve
      // those resolved identities rather than implementing a second package resolver here.
      const expectedName = spec.startsWith("npm:") ? spec.slice(4, spec.lastIndexOf("@")) : name;
      if (
        (!prefix && value.name !== expectedName) ||
        !value.name ||
        valid(value.version) !== value.version ||
        (!prefix && valid(spec) === spec && value.version !== spec)
      ) {
        throw new Error(`Node runtime dependency identity mismatch: ${name}@${spec}`);
      }
      const supports = (values: string[] | undefined, wanted: string) =>
        !values ||
        (!values.includes(`!${wanted}`) &&
          (!values.some((candidate) => !candidate.startsWith("!")) || values.includes(wanted)));
      if (!supports(value.os, target.platform) || !supports(value.cpu, target.arch)) {
        if (optional) {
          continue;
        }
        throw new Error(
          `Node runtime dependency ${name} does not support ${target.platform}/${target.arch}`,
        );
      }
      // Only the nearest visible placement may satisfy this edge: a nearer different
      // version shadows a matching root package. This also closes dependency cycles.
      const visible = ancestors.find((scope) => scope.has(name))?.get(name);
      if (visible === installed) {
        continue;
      }
      const hoisted = !rootPlacements.has(name);
      const destination = `${hoisted ? "" : prefix}node_modules/${name}/`;
      if (destination.split("/").length > 64) {
        throw new Error("Node runtime dependency nesting exceeds the archive depth limit");
      }
      if (hoisted) {
        rootPlacements.set(name, installed);
      } else {
        placements.set(name, installed);
      }
      const child = { requestedName: name, root: installed, prefix: destination, manifest: value };
      result.push(child);
      children.push({
        ...child,
        ancestors: hoisted ? [rootPlacements] : [placements, ...ancestors],
      });
    }
    for (const child of children) {
      await visit(child.root, child.manifest, child.prefix, child.ancestors);
    }
  };
  await visit(root, manifest, "", []);
  return result;
}

export type NodeBootstrapDependencyTarget = {
  platform: string;
  arch: string;
  root: string;
  prefix: string;
};

/** Offline inputs are qualified against the same installed source and frozen lock. */
export async function collectNodeBootstrapDependencyTargets(
  packageRoot: string,
  sourcePackage: DependencyManifest,
): Promise<NodeBootstrapDependencyTarget[]> {
  const targets: NodeBootstrapDependencyTarget[] = [
    { platform: process.platform, arch: process.arch, root: packageRoot, prefix: "" },
  ];
  const targetInputs = path.join(packageRoot, "node-runtime-dependencies");
  for (const entry of await fs
    .readdir(targetInputs, { withFileTypes: true })
    .catch((error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    })) {
    if (!entry.isDirectory() || !/^(linux|darwin|win32)-(x64|arm64)$/u.test(entry.name)) {
      throw new Error("Invalid node runtime dependency target input");
    }
    const [platform, arch] = entry.name.split("-") as [string, string];
    if (platform === process.platform && arch === process.arch) {
      continue;
    }
    const root = await fs.realpath(path.join(targetInputs, entry.name));
    if (root !== path.join(targetInputs, entry.name)) {
      throw new Error("Node runtime target input path is unsafe");
    }
    const inputPackage = JSON.parse(
      await fs.readFile(path.join(root, "package.json"), "utf8"),
    ) as DependencyManifest;
    const input = JSON.parse(await fs.readFile(path.join(root, "runtime-input.json"), "utf8")) as {
      platform?: string;
      arch?: string;
      packageJsonSha256?: string;
      lockfileSha256?: string;
    };
    if (
      input.platform !== platform ||
      input.arch !== arch ||
      input.packageJsonSha256 !==
        (await sha256File(path.join(packageRoot, "package.json"))).digest ||
      input.lockfileSha256 !==
        (await sha256File(path.join(packageRoot, "pnpm-lock.yaml"))).digest ||
      inputPackage.name !== sourcePackage.name ||
      inputPackage.version !== sourcePackage.version ||
      !isDeepStrictEqual(inputPackage.dependencies, sourcePackage.dependencies) ||
      !isDeepStrictEqual(inputPackage.optionalDependencies, sourcePackage.optionalDependencies)
    ) {
      throw new Error(
        `Node runtime target ${entry.name} does not match the running source/dependencies`,
      );
    }
    targets.push({ platform, arch, root, prefix: `runtime-dependencies/${entry.name}/` });
  }
  return targets;
}

/** Explicit npm installs retain main's bundled JavaScript and exact registry pins. */
export async function collectNodeBootstrapNpmDependencies(
  root: string,
  manifest: DependencyManifest,
) {
  const bundledNames = [
    ...new Set([
      ...(manifest.bundleDependencies ?? manifest.bundledDependencies ?? []),
      ...Object.entries(manifest.dependencies ?? {})
        .filter(([, spec]) => spec.startsWith("workspace:"))
        .map(([name]) => name),
    ]),
  ].toSorted();
  const rootDependencies = { ...manifest.dependencies };
  const dependencies: NodeBootstrapDependency[] = [];
  for (const name of bundledNames) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name)) {
      throw new Error(`Invalid node runtime dependency name: ${name}`);
    }
    const dependencyRoot = await fs.realpath(path.join(root, "node_modules", name));
    const bundled = JSON.parse(
      await fs.readFile(path.join(dependencyRoot, "package.json"), "utf8"),
    ) as DependencyManifest;
    if (bundled.name !== name || valid(bundled.version) !== bundled.version) {
      throw new Error(`Bundled node distribution dependency identity does not match ${name}`);
    }
    for (const [dependency, version] of validateBundledPackageDependencyAlignment({
      bundledDependencies: bundled.dependencies,
      bundledPackageLabel: `bundled ${name}`,
      rootDependencies,
    })) {
      rootDependencies[dependency] = version;
    }
    rootDependencies[name] = bundled.version;
    dependencies.push({
      requestedName: name,
      root: dependencyRoot,
      prefix: `node_modules/${name}/`,
      manifest: bundled,
    });
  }
  for (const [name, spec] of Object.entries({
    ...manifest.optionalDependencies,
    ...rootDependencies,
  })) {
    if (valid(spec) !== spec) {
      throw new Error(`Node distribution requires an exact dependency pin: ${name}@${spec}`);
    }
  }
  return { dependencies, rootDependencies, bundledNames };
}
