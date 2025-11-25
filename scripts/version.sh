#!/bin/bash
# Version management script for Libre Assistant

set -e

# Function to display usage
usage() {
    echo "Usage: $0 <version-type>"
    echo "version-type: major | minor | patch | <specific-version>"
    echo "Examples: $0 patch, $0 minor, $0 1.2.3"
    exit 1
}

# Check if a version type was provided
if [ -z "$1" ]; then
    usage
fi

# Get current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")

if [ "$1" = "major" ]; then
    NEW_VERSION=$(echo $CURRENT_VERSION | awk -F. '{print $1+1 ".0.0"}')
elif [ "$1" = "minor" ]; then
    NEW_VERSION=$(echo $CURRENT_VERSION | awk -F. '{print $1 "." $2+1 ".0"}')
elif [ "$1" = "patch" ]; then
    NEW_VERSION=$(echo $CURRENT_VERSION | awk -F. '{print $1 "." $2 "." $3+1}')
else
    # Use provided version
    NEW_VERSION=$1
fi

echo "Current version: $CURRENT_VERSION"
echo "New version: $NEW_VERSION"

# Update package.json
npm version $NEW_VERSION --no-git-tag-version

# Update the changelog
DATE=$(date +%Y-%m-%d)
if [ -f CHANGELOG.md ]; then
    sed -i "s/\[Unreleased\]/[${NEW_VERSION}] - ${DATE}/" CHANGELOG.md
    sed -i "/\[${NEW_VERSION}\] - ${DATE}/a \\\n## [Unreleased]\n" CHANGELOG.md
fi

echo "Version updated to $NEW_VERSION"
echo "Remember to commit the changes: git commit -a -m \"Bump version to $NEW_VERSION\""