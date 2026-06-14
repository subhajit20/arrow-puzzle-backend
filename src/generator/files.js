// =============================================================================
// files.js — the exact set of generator source files the server loads.
//
// Single source of truth shared by:
//   - loadGenerator.js  (loads these into the vm sandbox)
//   - scripts/sync-generator.js  (vendors these into backend/vendor/generator)
//
// Order matters: dependencies first (mirrors index.html / game.html load order).
// =============================================================================

module.exports = [
    'Grid.js', 'Path.js', 'SolvabilityOracle.js',
    'ZoneMap.js', 'RCBuilder.js', 'DifficultyEngine.js',
    'Validator.js', 'GridShape.js',
    'BoardBlueprint.js', 'PipelineConfig.js',
    'RegionLayout.js', 'RegionConnectivity.js',
    'TopologyGenerator.js', 'MotifAssigner.js',
    'MotifSkeletonGenerator.js', 'RegionNodeGraphBuilder.js', 'GlobalNodeGraphBuilder.js',
    'PathRouter.js', 'PathInteractionDetector.js',
    'DependencyGraphBuilder.js', 'SolveOrderPlanner.js',
    'BoardRepairer.js', 'Generator.js',
];
