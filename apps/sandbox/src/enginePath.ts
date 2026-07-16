let enginePath: string | null = null;

export const setEnginePath = (p: string): void => {
  enginePath = p;
};

export function getEnginePath(): string {
  if (!enginePath) throw new Error('engine path not set (setEnginePath must run before openEngine)');
  return enginePath;
}
