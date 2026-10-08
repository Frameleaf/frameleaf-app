---
sidebar_position: 100
---

# Config File

A config file can be provided as an alternative to the UI configuration.

:::note Interaction with the web UI
While the config file does not need to include all keys from the below example, specifying `FRAMELEAF_CONFIG_FILE` will disable the ability to edit other properties from the Frameleaf web UI.
:::

### Activating file changes

The server records the first validated file configuration as an activated epoch. Editing the mounted file does not activate new settings in an already running process. Each worker must have the same configuration file and environment overlay as the server; a worker that cannot reproduce the activated configuration refuses to use different file contents.

An administrator session can read `GET /api/system-config/config-file/activation`, then request `POST /api/system-config/config-file/reload` with only `{ "expectedEpoch": <the returned epoch> }`. The server reads its existing configured path, validates the complete candidate, and commits a new epoch only if the expected epoch still matches. Neither endpoint accepts a filename, configuration contents, credentials, or an environment override. API keys and shared links cannot activate configuration files.

A stale epoch returns `409`; read the current epoch before deciding whether to submit another activation. Invalid or unavailable files leave the activated epoch unchanged. If activation commits but its notification fails, the response is `503` with `effective_config_activated_notification_pending`: the committed epoch remains authoritative. Read the activation endpoint to reconcile before retrying. Responses are private and must not be cached.

Keep the activated file contents available to every worker. A process that has already captured that epoch continues using its immutable validated snapshot; a new process with different or missing contents fails closed. Changing between database and file configuration requires a controlled deployment decision, rather than implicitly replacing the existing source authority.

### Step 1 - Create a new config file

In JSON format, create a new config file (e.g. `frameleaf-config.json`) and put it in a location mounted in the container that can be accessed by Frameleaf.
YAML-formatted config files are also supported.
The default configuration looks like this:

<details>
<summary>frameleaf-config.json</summary>

```json
{
  "backup": {
    "database": {
      "cronExpression": "0 02 * * *",
      "enabled": true,
      "keepLastAmount": 14
    }
  },
  "ffmpeg": {
    "accel": "disabled",
    "accelDecode": true,
    "acceptedAudioCodecs": ["aac", "mp3", "opus"],
    "acceptedContainers": ["mov", "ogg", "webm"],
    "acceptedVideoCodecs": ["h264"],
    "bframes": -1,
    "cqMode": "auto",
    "crf": 23,
    "gopSize": 0,
    "maxBitrate": "0",
    "preferredHwDevice": "auto",
    "preset": "ultrafast",
    "refs": 0,
    "targetAudioCodec": "aac",
    "targetResolution": "720",
    "targetVideoCodec": "h264",
    "temporalAQ": false,
    "threads": 0,
    "tonemap": "hable",
    "transcode": "required",
    "twoPass": false
  },
  "image": {
    "colorspace": "p3",
    "extractEmbedded": false,
    "fullsize": {
      "enabled": false,
      "format": "jpeg",
      "quality": 80
    },
    "preview": {
      "format": "jpeg",
      "quality": 80,
      "size": 1440
    },
    "thumbnail": {
      "format": "webp",
      "quality": 80,
      "size": 250
    }
  },
  "job": {
    "backgroundTask": {
      "concurrency": 5
    },
    "faceDetection": {
      "concurrency": 2
    },
    "library": {
      "concurrency": 5
    },
    "metadataExtraction": {
      "concurrency": 5
    },
    "migration": {
      "concurrency": 5
    },
    "notifications": {
      "concurrency": 5
    },
    "ocr": {
      "concurrency": 1
    },
    "search": {
      "concurrency": 5
    },
    "sidecar": {
      "concurrency": 5
    },
    "smartSearch": {
      "concurrency": 2
    },
    "thumbnailGeneration": {
      "concurrency": 3
    },
    "videoConversion": {
      "concurrency": 1
    }
  },
  "library": {
    "scan": {
      "cronExpression": "0 0 * * *",
      "enabled": true
    },
    "watch": {
      "enabled": false
    }
  },
  "logging": {
    "enabled": true,
    "level": "log"
  },
  "machineLearning": {
    "availabilityChecks": {
      "enabled": true,
      "interval": 30000,
      "timeout": 2000
    },
    "clip": {
      "enabled": true,
      "modelName": "ViT-B-16-SigLIP-384__webli"
    },
    "duplicateDetection": {
      "enabled": true,
      "maxDistance": 0.01
    },
    "enabled": true,
    "facialRecognition": {
      "enabled": true,
      "maxDistance": 0.5,
      "minFaces": 3,
      "minScore": 0.7,
      "modelName": "buffalo_l"
    },
    "ocr": {
      "documentFields": false,
      "enabled": true,
      "maxResolution": 736,
      "minDetectionScore": 0.5,
      "minRecognitionScore": 0.8,
      "modelName": "PP-OCRv5_mobile"
    },
    "urls": ["http://immich-machine-learning:3003"]
  },
  "map": {
    "darkStyle": "https://tiles.frameleaf.cloud/v1/style/dark.json",
    "enabled": true,
    "lightStyle": "https://tiles.frameleaf.cloud/v1/style/light.json"
  },
  "metadata": {
    "faces": {
      "import": false
    }
  },
  "newVersionCheck": {
    "enabled": false,
    "channel": "stable"
  },
  "nightlyTasks": {
    "clusterNewFaces": true,
    "databaseCleanup": true,
    "generateMemories": true,
    "missingThumbnails": true,
    "startTime": "00:00",
    "syncQuotaUsage": true
  },
  "notifications": {
    "smtp": {
      "enabled": false,
      "from": "",
      "replyTo": "",
      "transport": {
        "host": "",
        "ignoreCert": false,
        "password": "",
        "port": 587,
        "secure": false,
        "username": ""
      }
    }
  },
  "oauth": {
    "autoLaunch": false,
    "autoRegister": true,
    "buttonText": "Login with OAuth",
    "clientId": "",
    "clientSecret": "",
    "defaultStorageQuota": null,
    "enabled": false,
    "issuerUrl": "",
    "endSessionEndpoint": "",
    "mobileOverrideEnabled": false,
    "mobileRedirectUri": "",
    "profileSigningAlgorithm": "none",
    "roleClaim": "immich_role",
    "scope": "openid email profile",
    "signingAlgorithm": "RS256",
    "storageLabelClaim": "preferred_username",
    "storageQuotaClaim": "immich_quota",
    "timeout": 30000,
    "tokenEndpointAuthMethod": "client_secret_post"
  },
  "passwordLogin": {
    "enabled": true
  },
  "reverseGeocoding": {
    "enabled": true
  },
  "server": {
    "externalDomain": "",
    "loginPageMessage": "",
    "publicUsers": true
  },
  "storageTemplate": {
    "enabled": false,
    "hashVerificationEnabled": true,
    "template": "{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}"
  },
  "templates": {
    "email": {
      "albumInviteTemplate": "",
      "albumUpdateTemplate": "",
      "welcomeTemplate": ""
    }
  },
  "theme": {
    "customCss": ""
  },
  "trash": {
    "days": 30,
    "enabled": true
  },
  "user": {
    "deleteDelay": 7
  }
}
```

</details>

:::tip
In Administration > Settings is a button to copy the current configuration to your clipboard.
So you can just grab it from there, paste it into a file and you're pretty much good to go.
:::

### Step 2 - Specify the file location

:::note
If you have any `microservices` workers, they will also need to have the config file mounted to their container.
:::

In your `.env` file, set the variable `FRAMELEAF_CONFIG_FILE` to the path of your config.
For more information, refer to the [Environment Variables](/install/environment-variables.md) section.

:::info Docker Compose
In your `.env` file, the variables `UPLOAD_LOCATION` and `DB_DATA_LOCATION` concern the location on the host.
However, the variable `FRAMELEAF_CONFIG_FILE` concerns the location inside the container, and informs the server container that a configuration file is present.

It is recommended to reuse this variable in your `docker-compose.yml`:

```yaml
volumes:
  - ./frameleaf-config.json:${FRAMELEAF_CONFIG_FILE}
```

:::
