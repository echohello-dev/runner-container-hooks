/** @type {import('ts-jest').JestConfigWithTsJest} */
const config = {
  preset: 'ts-jest',
  clearMocks: true,
  testEnvironment: 'node',
  testMatch: ['**/*-test.ts'],
  rootDir: './',
  projects: ['<rootDir>', '<rootDir>/packages/*'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js']
}

module.exports = config
