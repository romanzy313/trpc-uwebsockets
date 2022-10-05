/* eslint-disable no-undef */
// /* eslint-disable no-undef */
// // Sync object
// This is a mess :(
// /** @type {import('@jest/types').Config.InitialOptions} */
// const config = {
//   // verbose: true,
//   transform: {
//     '^.+\\.(t|j)sx?$': ['@swc/jest'],
//   },
//   // if browser library:
//   testEnvironment: 'jest-environment-jsdom',

//   // if difficulties with imports:
//   extensionsToTreatAsEsm: ['.ts'],
//   moduleNameMapper: {
//     '^(\\.{1,2}/.*)\\.js$': '$1',
//   },
//   transformIgnorePatterns: ['<rootDir>/node_modules/'],
// };

/** @type {import('@jest/types').Config.InitialOptions} */
const config = {
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  transform: {
    '^.+\\.ts?$': 'ts-jest',
  },
  transformIgnorePatterns: ['<rootDir>/node_modules/'],
};
module.exports = config;
