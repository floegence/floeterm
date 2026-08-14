export const topContractForPlatform = platform => {
  switch (platform) {
    case 'darwin':
      return {
        command: 'top -s 1',
        headerPrefix: 'Processes:',
        loadPrefix: 'Load Avg:',
      };
    case 'linux':
      return {
        command: 'top -d 1',
        headerPrefix: 'top - ',
        loadPrefix: 'Tasks:',
      };
    default:
      throw new Error(`unsupported top platform: ${platform}`);
  }
};
