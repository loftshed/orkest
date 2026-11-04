/**
 * @module foundry
 *
 * The Foundry (`ork foundry` / `ork factory`): Spare-token software factory.
 * Harvests open GitHub issues (`Depends on #N` DAG-aware) when flat-rate
 * subscription pools (`monitor`) have expiring surplus quota, provisions
 * isolated disposable git worktrees (`.worktreeinclude`), and dispatches
 * bounded worker runs.
 */
export * from "./factory.mjs";
export {
  FACTORY_HELP as FOUNDRY_HELP,
  factoryCli as foundryCli,
  factoryCommand as foundryCommand,
  factoryGroom as foundryGroom,
  factoryRun as foundryRun,
  factoryStatus as foundryStatus,
} from "./factory.mjs";
