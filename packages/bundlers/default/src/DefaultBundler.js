// @flow strict-local

import type {
  Asset,
  Bundle,
  BundleGroup,
  MutableBundleGraph,
} from '@parcel/types';

import invariant from 'assert';
import {Bundler} from '@parcel/plugin';
import {md5FromString} from '@parcel/utils';
import nullthrows from 'nullthrows';

const OPTIONS = {
  minBundles: 1,
  minBundleSize: 30000,
  maxParallelRequests: 5,
};

export default new Bundler({
  // RULES:
  // 1. If dep.isAsync or dep.isEntry, start a new bundle group.
  // 2. If an asset is a different type than the current bundle, make a parallel bundle in the same bundle group.
  // 3. If an asset is already in a parent bundle in the same entry point, exclude from child bundles.
  // 4. If an asset is only in separate isolated entry points (e.g. workers, different HTML pages), duplicate it.
  // 5. If the sub-graph from an asset is >= 30kb, and the number of parallel requests in the bundle group is < 5, create a new bundle containing the sub-graph.
  // 6. If two assets are always seen together, put them in the same extracted bundle

  bundle({bundleGraph}) {
    let bundleRoots: Map<Bundle, Array<Asset>> = new Map();
    let bundlesByEntryAsset: Map<Asset, Bundle> = new Map();
    let siblingBundlesByAsset: Map<string, Array<Bundle>> = new Map();

    // Step 1: create bundles for each of the explicit code split points.
    bundleGraph.traverse({
      enter: (node, context) => {
        if (node.type !== 'dependency') {
          return {
            ...context,
            bundleGroup: context?.bundleGroup,
            bundleByType: context?.bundleByType,
            bundleGroupDependency: context?.bundleGroupDependency,
            parentNode: node,
            parentBundle:
              bundlesByEntryAsset.get(node.value) ?? context?.parentBundle,
          };
        }

        let dependency = node.value;
        let assets = bundleGraph.getDependencyAssets(dependency);
        let resolution = bundleGraph.getDependencyResolution(dependency);

        if (
          (dependency.isEntry && resolution) ||
          (dependency.isAsync && resolution) ||
          resolution?.isIsolated ||
          resolution?.isInline
        ) {
          let bundleGroup = bundleGraph.createBundleGroup(
            dependency,
            nullthrows(dependency.target ?? context?.bundleGroup?.target),
          );

          let bundleByType: Map<string, Bundle> = new Map();

          for (let asset of assets) {
            let bundle = bundleGraph.createBundle({
              entryAsset: asset,
              isEntry: asset.isIsolated ? false : Boolean(dependency.isEntry),
              isInline: asset.isInline,
              target: bundleGroup.target,
            });
            bundleByType.set(bundle.type, bundle);
            bundleRoots.set(bundle, [asset]);
            bundlesByEntryAsset.set(asset, bundle);
            siblingBundlesByAsset.set(asset.id, []);
            bundleGraph.addBundleToBundleGroup(bundle, bundleGroup);
          }

          return {
            bundleGroup,
            bundleByType,
            bundleGroupDependency: dependency,
            parentNode: node,
            parentBundle: context?.parentBundle,
          };
        }

        invariant(context != null);
        invariant(context.parentNode.type === 'asset');
        invariant(context.parentBundle != null);
        let parentAsset = context.parentNode.value;
        let parentBundle = context.parentBundle;
        let bundleGroup = nullthrows(context.bundleGroup);
        let bundleGroupDependency = nullthrows(context.bundleGroupDependency);
        let bundleByType = nullthrows(context.bundleByType);
        let siblingBundles = nullthrows(
          siblingBundlesByAsset.get(parentAsset.id),
        );
        let allSameType = assets.every(a => a.type === parentAsset.type);

        for (let asset of assets) {
          let siblings = siblingBundlesByAsset.get(asset.id);

          if (parentAsset.type === asset.type) {
            if (allSameType && siblings) {
              // If any sibling bundles were created for this asset or its subtree previously,
              // add them all to the current bundle group as well. This fixes cases where two entries
              // depend on a shared asset which has siblings. Due to DFS, the subtree of the shared
              // asset is only processed once, meaning any sibling bundles created due to type changes
              // would only be connected to the first bundle group. To work around this, we store a list
              // of sibling bundles for each asset in the graph, and when we re-visit a shared asset, we
              // connect them all to the current bundle group as well.
              for (let bundle of siblings) {
                bundleGraph.addBundleToBundleGroup(bundle, bundleGroup);
              }
            } else if (!siblings) {
              // Propagate the same siblings further if there are no bundles being created in this
              // asset group, otherwise start a new set of siblings.
              siblingBundlesByAsset.set(
                asset.id,
                allSameType ? siblingBundles : [],
              );
            }

            continue;
          }

          let existingBundle = bundleByType.get(asset.type);
          if (existingBundle) {
            // If a bundle of this type has already been created in this group,
            // merge this subgraph into it.
            nullthrows(bundleRoots.get(existingBundle)).push(asset);
            bundleGraph.createAssetReference(dependency, asset);
          } else {
            let bundle = bundleGraph.createBundle({
              entryAsset: asset,
              target: bundleGroup.target,
              isEntry: bundleGroupDependency.isEntry,
              isInline: asset.isInline,
            });
            bundleByType.set(bundle.type, bundle);
            siblingBundles.push(bundle);
            bundleRoots.set(bundle, [asset]);
            bundlesByEntryAsset.set(asset, bundle);
            bundleGraph.createAssetReference(dependency, asset);
            bundleGraph.createBundleReference(parentBundle, bundle);
            bundleGraph.addBundleToBundleGroup(bundle, bundleGroup);
          }

          if (!siblings) {
            siblingBundlesByAsset.set(asset.id, []);
          }
        }

        return {
          ...context,
          parentNode: node,
        };
      },
    });

    for (let [bundle, rootAssets] of bundleRoots) {
      for (let asset of rootAssets) {
        bundleGraph.addAssetGraphToBundle(asset, bundle);
      }
    }
  },

  optimize({bundleGraph}) {
    // Step 2: Remove asset graphs that begin with entries to other bundles.
    bundleGraph.traverseBundles(bundle => {
      if (bundle.isInline || !bundle.isSplittable) {
        return;
      }

      let mainEntry = bundle.getMainEntry();
      if (mainEntry == null) {
        return;
      }

      let siblings = bundleGraph
        .getReferencedBundles(bundle)
        .filter(sibling => !sibling.isInline);
      let candidates = bundleGraph.findBundlesWithAsset(mainEntry).filter(
        containingBundle =>
          containingBundle.id !== bundle.id &&
          // Don't add to BundleGroups for entry bundles, as that would require
          // another entry bundle depending on these conditions, making it difficult
          // to predict and reference.
          !containingBundle.isEntry &&
          !containingBundle.isInline &&
          containingBundle.isSplittable,
      );

      for (let candidate of candidates) {
        let bundleGroups = bundleGraph.getBundleGroupsContainingBundle(
          candidate,
        );
        if (
          Array.from(bundleGroups).every(
            group =>
              bundleGraph.getBundlesInBundleGroup(group).length <
              OPTIONS.maxParallelRequests,
          )
        ) {
          bundleGraph.removeAssetGraphFromBundle(mainEntry, candidate);
          for (let bundleGroup of bundleGroups) {
            for (let bundleToAdd of [bundle, ...siblings]) {
              bundleGraph.addBundleToBundleGroup(bundleToAdd, bundleGroup);
            }
          }
        }
      }
    });

    // Step 3: Remove assets that are duplicated in a parent bundle.
    bundleGraph.traverseBundles({
      exit(bundle) {
        deduplicateBundle(bundleGraph, bundle);
      },
    });

    // Step 4: Find duplicated assets in different bundle groups, and separate them into their own parallel bundles.
    // If multiple assets are always seen together in the same bundles, combine them together.
    let candidateBundles: Map<
      string,
      {|
        assets: Array<Asset>,
        sourceBundles: Set<Bundle>,
        size: number,
      |},
    > = new Map();

    bundleGraph.traverseContents((node, ctx, actions) => {
      if (node.type !== 'asset') {
        return;
      }

      let asset = node.value;
      let containingBundles = bundleGraph
        .findBundlesWithAsset(asset)
        // Don't create shared bundles from entry bundles, as that would require
        // another entry bundle depending on these conditions, making it difficult
        // to predict and reference.
        .filter(b => {
          let mainEntry = b.getMainEntry();

          return (
            !b.isEntry &&
            b.isSplittable &&
            (mainEntry == null || mainEntry.id !== asset.id)
          );
        });

      if (containingBundles.length > OPTIONS.minBundles) {
        let id = containingBundles
          .map(b => b.id)
          .sort()
          .join(':');

        let candidate = candidateBundles.get(id);
        if (candidate) {
          candidate.assets.push(asset);
          for (let bundle of containingBundles) {
            candidate.sourceBundles.add(bundle);
          }
          candidate.size += bundleGraph.getTotalSize(asset);
        } else {
          candidateBundles.set(id, {
            assets: [asset],
            sourceBundles: new Set(containingBundles),
            size: bundleGraph.getTotalSize(asset),
          });
        }

        // Skip children from consideration since we added a parent already.
        actions.skipChildren();
      }
    });

    // Sort candidates by size (consider larger bundles first), and ensure they meet the size threshold
    let sortedCandidates: Array<{|
      assets: Array<Asset>,
      sourceBundles: Set<Bundle>,
      size: number,
    |}> = Array.from(candidateBundles.values())
      .filter(bundle => bundle.size >= OPTIONS.minBundleSize)
      .sort((a, b) => b.size - a.size);

    for (let {assets, sourceBundles} of sortedCandidates) {
      // Find all bundle groups connected to the original bundles
      let bundleGroups = new Set();

      for (let bundle of sourceBundles) {
        for (let bundleGroup of bundleGraph.getBundleGroupsContainingBundle(
          bundle,
        )) {
          bundleGroups.add(bundleGroup);
        }
      }

      // Check that all the bundle groups are inside the parallel request limit.
      if (
        Array.from(bundleGroups).some(
          group =>
            bundleGraph.getBundlesInBundleGroup(group).length >=
            OPTIONS.maxParallelRequests,
        )
      ) {
        continue;
      }

      let [firstBundle] = [...sourceBundles];
      let sharedBundle = bundleGraph.createBundle({
        uniqueKey: md5FromString([...sourceBundles].map(b => b.id).join(':')),
        // Allow this bundle to be deduplicated. It shouldn't be further split.
        // TODO: Reconsider bundle/asset flags.
        isSplittable: true,
        env: firstBundle.env,
        target: firstBundle.target,
        type: firstBundle.type,
      });

      // Remove all of the root assets from each of the original bundles
      for (let asset of assets) {
        bundleGraph.addAssetGraphToBundle(asset, sharedBundle);
        for (let bundle of sourceBundles) {
          bundleGraph.removeAssetGraphFromBundle(asset, bundle);
        }
      }

      // Create new bundle node and connect it to all of the original bundle groups
      for (let bundleGroup of bundleGroups) {
        bundleGraph.addBundleToBundleGroup(sharedBundle, bundleGroup);
      }

      deduplicateBundle(bundleGraph, sharedBundle);
    }

    // Step 5: Mark async dependencies on assets that are already available in
    // the bundle as internally resolvable. This removes the dependency between
    // the bundle and the bundle group providing that asset. If all connections
    // to that bundle group are removed, remove that bundle group.
    let asyncBundleGroups: Set<BundleGroup> = new Set();
    bundleGraph.traverse(node => {
      if (
        node.type !== 'dependency' ||
        node.value.isEntry ||
        !node.value.isAsync
      ) {
        return;
      }

      let dependency = node.value;
      let resolution = bundleGraph.getDependencyResolution(dependency);
      if (resolution == null) {
        return;
      }

      let externalResolution = bundleGraph.resolveExternalDependency(
        dependency,
      );
      invariant(externalResolution?.type === 'bundle_group');
      asyncBundleGroups.add(externalResolution.value);

      for (let bundle of bundleGraph.findBundlesWithDependency(dependency)) {
        if (
          bundle.hasAsset(resolution) ||
          bundleGraph.isAssetInAncestorBundles(bundle, resolution)
        ) {
          bundleGraph.internalizeAsyncDependency(bundle, dependency);
        }
      }
    });

    // Remove any bundle groups that no longer have any parent bundles.
    for (let bundleGroup of asyncBundleGroups) {
      if (bundleGraph.getParentBundlesOfBundleGroup(bundleGroup).length === 0) {
        bundleGraph.removeBundleGroup(bundleGroup);
      }
    }
  },
});

function deduplicateBundle(bundleGraph: MutableBundleGraph, bundle: Bundle) {
  if (bundle.env.isIsolated() || !bundle.isSplittable) {
    // If a bundle's environment is isolated, it can't access assets present
    // in any ancestor bundles. Don't deduplicate any assets.
    return;
  }

  bundle.traverse(node => {
    if (node.type !== 'dependency') {
      return;
    }

    let dependency = node.value;
    let assets = bundleGraph.getDependencyAssets(dependency);

    for (let asset of assets) {
      if (
        bundle.hasAsset(asset) &&
        bundleGraph.isAssetInAncestorBundles(bundle, asset)
      ) {
        bundleGraph.removeAssetGraphFromBundle(asset, bundle);
      }
    }
  });
}
