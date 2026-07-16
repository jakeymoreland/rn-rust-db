module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  moduleNameMapper: {
    '^react-native$': '<rootDir>/src/__tests__/rn-mock.ts',
    'react-native/Libraries/Types/CodegenTypes': '<rootDir>/src/__tests__/codegen-types-mock.ts',
  },
};
