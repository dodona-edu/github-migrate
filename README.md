# GitHub Migrate

Script to migrate a repository from one GitHub instance to another.

This was used to migrate our repostories from a GitHub enterprise instance to
github.com.

## Installation

1. Clone this repository
```
git clone git@github.com:dodona-edu/github-migrate.git && cd github-migrate
```

2. Install dependencies
```
npm install
```

3. Copy and edit configuration file
```
cp config.example.yml config.yml && $EDITOR config.yml
```

## Usage

Perform migration (more info about the parameters in config.example.yml) with
```
npm run start [--source=<source_url>] [--destination=<destination_url>] [--reset] [--overwrite] [--for-real]
```



