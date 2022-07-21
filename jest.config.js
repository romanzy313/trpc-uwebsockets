/* eslint-disable no-undef */
// Sync object
/** @type {import('@jest/types').Config.InitialOptions} */
const config = {
  // verbose: true,
  transform: {
    '^.+\\.(t|j)sx?$': ['@swc/jest'],
  },
  // if browser library:
  // testEnvironment: 'jsdom',

  // if difficulties with imports:
  // extensionsToTreatAsEsm: ['.ts'],
  // moduleNameMapper: {
  //   '^(\\.{1,2}/.*)\\.js$': '$1',
  // },
  // transformIgnorePatterns: ['<rootDir>/node_modules/'],
};

module.exports = config;
