#!/bin/bash

echo "🔍 Pre-publish verification for vite-plugin-proxy-http2"
echo ""

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Run this script from the project root."
    exit 1
fi

# Check if npm is logged in
echo "📦 Checking npm login status..."
npm_user=$(npm whoami 2>/dev/null)
if [ $? -ne 0 ]; then
    echo "❌ You are not logged in to npm. Run 'npm login' first."
    exit 1
else
    echo "✅ Logged in as: $npm_user"
fi

# Run build
echo ""
echo "🔨 Building package..."
pnpm run build
if [ $? -ne 0 ]; then
    echo "❌ Build failed!"
    exit 1
fi
echo "✅ Build successful"

# Run tests
echo ""
echo "🧪 Running tests..."
pnpm run test
if [ $? -ne 0 ]; then
    echo "❌ Tests failed!"
    exit 1
fi
echo "✅ All tests passed"

# Run type check
echo ""
echo "📝 Running type check..."
pnpm run typecheck
if [ $? -ne 0 ]; then
    echo "❌ Type check failed!"
    exit 1
fi
echo "✅ Type check passed"

# Check what will be published
echo ""
echo "📋 Files that will be published:"
npm pack --dry-run 2>&1 | grep -E "^npm notice"

# Get package info
package_name=$(node -p "require('./package.json').name")
package_version=$(node -p "require('./package.json').version")

echo ""
echo "📦 Package: $package_name@$package_version"
echo ""

# Check if version already exists
echo "🔍 Checking if version already exists on npm..."
npm view "$package_name@$package_version" version 2>/dev/null
if [ $? -eq 0 ]; then
    echo "❌ Version $package_version already exists on npm!"
    echo "   Update the version in package.json before publishing."
    exit 1
else
    echo "✅ Version $package_version is available"
fi

echo ""
echo "✅ All checks passed! Ready to publish."
echo ""
echo "To publish, run:"
echo "  npm publish"
echo ""
echo "Or to do a dry run first:"
echo "  npm publish --dry-run"