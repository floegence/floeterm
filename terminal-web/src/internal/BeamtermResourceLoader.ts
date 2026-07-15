export type BeamtermModule = typeof import('@beamterm/renderer');

let beamtermModulePromise: Promise<BeamtermModule> | null = null;

export const loadBeamtermModule = async (): Promise<BeamtermModule> => {
  if (!beamtermModulePromise) {
    beamtermModulePromise = import('@beamterm/renderer').then(async module => {
      await module.main();
      return module;
    }).catch((error: unknown) => {
      beamtermModulePromise = null;
      throw error;
    });
  }
  return beamtermModulePromise;
};
