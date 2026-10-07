# Server API models 24

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## PhotographyWorkflowDto


```json
{
  "properties": {
    "approvals": {
      "items": {
        "properties": {
          "approved": {
            "type": "boolean"
          },
          "captureId": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "createdAt": {
            "type": "string"
          },
          "note": {
            "type": "string"
          },
          "recipientId": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "revisionId": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          }
        },
        "required": [
          "recipientId",
          "captureId",
          "revisionId",
          "approved",
          "note",
          "createdAt"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "approvedVersions": {
      "items": {
        "properties": {
          "approvedAt": {
            "type": "string"
          },
          "captureId": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "revisionId": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          }
        },
        "required": [
          "captureId",
          "revisionId",
          "approvedAt"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "captures": {
      "items": {
        "properties": {
          "approvalRequested": {
            "type": "boolean"
          },
          "approvedRevisionId": {
            "format": "uuid",
            "nullable": true,
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "assetId": {
            "format": "uuid",
            "nullable": true,
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "assetIds": {
            "items": {
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
              "type": "string"
            },
            "maxItems": 10000,
            "type": "array"
          },
          "camera": {
            "nullable": true,
            "type": "string"
          },
          "capturedAt": {
            "nullable": true,
            "type": "string"
          },
          "chapterId": {
            "format": "uuid",
            "nullable": true,
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "checksum": {
            "nullable": true,
            "type": "string"
          },
          "eligible": {
            "type": "boolean"
          },
          "exclusion": {
            "nullable": true,
            "type": "string"
          },
          "fileName": {
            "nullable": true,
            "type": "string"
          },
          "id": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "isRaw": {
            "nullable": true,
            "type": "boolean"
          },
          "number": {
            "maximum": 9007199254740991,
            "minimum": -9007199254740991,
            "type": "integer"
          },
          "offsetSeconds": {
            "maximum": 9007199254740991,
            "minimum": -9007199254740991,
            "type": "integer"
          },
          "photographer": {
            "type": "string"
          },
          "position": {
            "maximum": 9007199254740991,
            "minimum": -9007199254740991,
            "type": "integer"
          },
          "processing": {
            "enum": [
              "ready",
              "pending",
              "failed"
            ],
            "type": "string"
          },
          "proofRevisionId": {
            "format": "uuid",
            "nullable": true,
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "rating": {
            "maximum": 9007199254740991,
            "minimum": -9007199254740991,
            "nullable": true,
            "type": "integer"
          },
          "state": {
            "enum": [
              "imported",
              "selected",
              "approval-requested",
              "approved",
              "delivered"
            ],
            "type": "string"
          },
          "withheld": {
            "type": "boolean"
          }
        },
        "required": [
          "id",
          "number",
          "assetId",
          "assetIds",
          "checksum",
          "fileName",
          "camera",
          "capturedAt",
          "offsetSeconds",
          "photographer",
          "chapterId",
          "position",
          "withheld",
          "rating",
          "isRaw",
          "eligible",
          "exclusion",
          "processing",
          "proofRevisionId",
          "approvedRevisionId",
          "approvalRequested",
          "state"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "chapters": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "coverCaptureId": {
            "format": "uuid",
            "nullable": true,
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "description": {
            "maxLength": 2000,
            "type": "string"
          },
          "id": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "position": {
            "maximum": 10000,
            "minimum": 0,
            "type": "integer"
          },
          "title": {
            "maxLength": 200,
            "minLength": 1,
            "type": "string"
          }
        },
        "required": [
          "id",
          "title",
          "description",
          "position",
          "coverCaptureId"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "config": {
      "additionalProperties": false,
      "properties": {
        "additionalPrice": {
          "maximum": 100000000,
          "minimum": 0,
          "type": "integer"
        },
        "bundles": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "count": {
                "maximum": 10000,
                "minimum": 1,
                "type": "integer"
              },
              "price": {
                "maximum": 100000000,
                "minimum": 0,
                "type": "integer"
              }
            },
            "required": [
              "count",
              "price"
            ],
            "type": "object"
          },
          "maxItems": 20,
          "type": "array"
        },
        "collectionPrice": {
          "maximum": 100000000,
          "minimum": 0,
          "nullable": true,
          "type": "integer"
        },
        "currency": {
          "pattern": "^[A-Z]{3}$",
          "type": "string"
        },
        "downloadOutputs": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "key": {
                "pattern": "^[a-z][a-z0-9-]{0,39}$",
                "type": "string"
              },
              "kind": {
                "enum": [
                  "print",
                  "web",
                  "social"
                ],
                "type": "string"
              },
              "label": {
                "maxLength": 100,
                "minLength": 1,
                "type": "string"
              },
              "maxEdge": {
                "maximum": 65535,
                "minimum": 320,
                "type": "integer"
              },
              "watermark": {
                "additionalProperties": false,
                "nullable": true,
                "properties": {
                  "alignment": {
                    "default": "center",
                    "enum": [
                      "left",
                      "center",
                      "right"
                    ],
                    "type": "string"
                  },
                  "backing": {
                    "default": false,
                    "type": "boolean"
                  },
                  "color": {
                    "default": "#ffffff",
                    "pattern": "^#[\\da-fA-F]{6}$",
                    "type": "string"
                  },
                  "font": {
                    "default": "script",
                    "enum": [
                      "script",
                      "serif",
                      "sans"
                    ],
                    "type": "string"
                  },
                  "logoAssetId": {
                    "default": null,
                    "format": "uuid",
                    "nullable": true,
                    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                    "type": "string"
                  },
                  "logoPosition": {
                    "default": "above",
                    "enum": [
                      "above",
                      "below",
                      "left",
                      "right"
                    ],
                    "type": "string"
                  },
                  "logoScale": {
                    "default": 1,
                    "maximum": 4,
                    "minimum": 0.25,
                    "type": "number"
                  },
                  "logoVariant": {
                    "default": "original",
                    "enum": [
                      "original",
                      "light",
                      "dark"
                    ],
                    "type": "string"
                  },
                  "margin": {
                    "default": 4,
                    "maximum": 25,
                    "minimum": 0,
                    "type": "number"
                  },
                  "opacity": {
                    "default": 45,
                    "maximum": 100,
                    "minimum": 1,
                    "type": "number"
                  },
                  "outline": {
                    "default": false,
                    "type": "boolean"
                  },
                  "pattern": {
                    "default": "signature",
                    "enum": [
                      "signature",
                      "centre",
                      "diagonal",
                      "tile"
                    ],
                    "type": "string"
                  },
                  "position": {
                    "default": "bottom-right",
                    "enum": [
                      "top-left",
                      "top-right",
                      "bottom-left",
                      "bottom-right",
                      "center"
                    ],
                    "type": "string"
                  },
                  "rotation": {
                    "default": 0,
                    "maximum": 180,
                    "minimum": -180,
                    "type": "number"
                  },
                  "secondLine": {
                    "default": "",
                    "maxLength": 200,
                    "type": "string"
                  },
                  "size": {
                    "default": 6,
                    "maximum": 30,
                    "minimum": 1,
                    "type": "number"
                  },
                  "spacing": {
                    "default": 6,
                    "maximum": 100,
                    "minimum": 0,
                    "type": "number"
                  },
                  "text": {
                    "maxLength": 200,
                    "minLength": 1,
                    "type": "string"
                  },
                  "type": {
                    "default": "text",
                    "enum": [
                      "text",
                      "logo",
                      "both"
                    ],
                    "type": "string"
                  }
                },
                "required": [
                  "text"
                ],
                "type": "object"
              }
            },
            "required": [
              "key",
              "label",
              "kind",
              "maxEdge",
              "watermark"
            ],
            "type": "object"
          },
          "maxItems": 6,
          "minItems": 1,
          "type": "array"
        },
        "downloadWatermark": {
          "additionalProperties": false,
          "nullable": true,
          "properties": {
            "alignment": {
              "default": "center",
              "enum": [
                "left",
                "center",
                "right"
              ],
              "type": "string"
            },
            "backing": {
              "default": false,
              "type": "boolean"
            },
            "color": {
              "default": "#ffffff",
              "pattern": "^#[\\da-fA-F]{6}$",
              "type": "string"
            },
            "font": {
              "default": "script",
              "enum": [
                "script",
                "serif",
                "sans"
              ],
              "type": "string"
            },
            "logoAssetId": {
              "default": null,
              "format": "uuid",
              "nullable": true,
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
              "type": "string"
            },
            "logoPosition": {
              "default": "above",
              "enum": [
                "above",
                "below",
                "left",
                "right"
              ],
              "type": "string"
            },
            "logoScale": {
              "default": 1,
              "maximum": 4,
              "minimum": 0.25,
              "type": "number"
            },
            "logoVariant": {
              "default": "original",
              "enum": [
                "original",
                "light",
                "dark"
              ],
              "type": "string"
            },
            "margin": {
              "default": 4,
              "maximum": 25,
              "minimum": 0,
              "type": "number"
            },
            "opacity": {
              "default": 45,
              "maximum": 100,
              "minimum": 1,
              "type": "number"
            },
            "outline": {
              "default": false,
              "type": "boolean"
            },
            "pattern": {
              "default": "signature",
              "enum": [
                "signature",
                "centre",
                "diagonal",
                "tile"
              ],
              "type": "string"
            },
            "position": {
              "default": "bottom-right",
              "enum": [
                "top-left",
                "top-right",
                "bottom-left",
                "bottom-right",
                "center"
              ],
              "type": "string"
            },
            "rotation": {
              "default": 0,
              "maximum": 180,
              "minimum": -180,
              "type": "number"
            },
            "secondLine": {
              "default": "",
              "maxLength": 200,
              "type": "string"
            },
            "size": {
              "default": 6,
              "maximum": 30,
              "minimum": 1,
              "type": "number"
            },
            "spacing": {
              "default": 6,
              "maximum": 100,
              "minimum": 0,
              "type": "number"
            },
            "text": {
              "maxLength": 200,
              "minLength": 1,
              "type": "string"
            },
            "type": {
              "default": "text",
              "enum": [
                "text",
                "logo",
                "both"
              ],
              "type": "string"
            }
          },
          "required": [
            "text"
          ],
          "type": "object"
        },
        "expiresAt": {
          "format": "date-time",
          "nullable": true,
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
          "type": "string"
        },
        "includedCount": {
          "maximum": 10000,
          "minimum": 0,
          "type": "integer"
        },
        "mode": {
          "enum": [
            "edited-delivery",
            "select-before-editing",
            "sell-by-photo"
          ],
          "type": "string"
        },
        "paymentTiming": {
          "enum": [
            "before-editing",
            "after-approval"
          ],
          "type": "string"
        },
        "presentation": {
          "additionalProperties": false,
          "properties": {
            "blocks": {
              "items": {
                "additionalProperties": false,
                "properties": {
                  "captureIds": {
                    "items": {
                      "format": "uuid",
                      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                      "type": "string"
                    },
                    "maxItems": 1000,
                    "type": "array"
                  },
                  "chapterId": {
                    "format": "uuid",
                    "nullable": true,
                    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                    "type": "string"
                  },
                  "id": {
                    "format": "uuid",
                    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                    "type": "string"
                  },
                  "selection": {
                    "enum": [
                      "automatic",
                      "explicit"
                    ],
                    "type": "string"
                  },
                  "text": {
                    "maxLength": 2000,
                    "type": "string"
                  },
                  "type": {
                    "enum": [
                      "chapter",
                      "grid",
                      "full",
                      "pair",
                      "caption",
                      "slideshow"
                    ],
                    "type": "string"
                  }
                },
                "required": [
                  "id",
                  "type",
                  "chapterId",
                  "captureIds",
                  "text"
                ],
                "type": "object"
              },
              "maxItems": 100,
              "type": "array"
            },
            "coverCaptureId": {
              "format": "uuid",
              "nullable": true,
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
              "type": "string"
            },
            "coverFocal": {
              "maximum": 100,
              "minimum": 0,
              "type": "number"
            },
            "coverTreatment": {
              "enum": [
                "full",
                "split",
                "quiet"
              ],
              "type": "string"
            },
            "font": {
              "enum": [
                "editorial",
                "modern",
                "script"
              ],
              "type": "string"
            },
            "introduction": {
              "maxLength": 5000,
              "type": "string"
            },
            "palette": {
              "enum": [
                "studio",
                "ivory",
                "charcoal"
              ],
              "type": "string"
            },
            "showChapters": {
              "type": "boolean"
            },
            "showNumbers": {
              "type": "boolean"
            },
            "spacing": {
              "enum": [
                "compact",
                "comfortable",
                "airy"
              ],
              "type": "string"
            },
            "template": {
              "enum": [
                "wedding",
                "portrait",
                "fine-art",
                "proofing"
              ],
              "type": "string"
            }
          },
          "required": [
            "template",
            "coverCaptureId",
            "coverTreatment",
            "coverFocal",
            "font",
            "palette",
            "spacing",
            "introduction",
            "showChapters",
            "showNumbers"
          ],
          "type": "object"
        },
        "proofWatermark": {
          "additionalProperties": false,
          "properties": {
            "alignment": {
              "default": "center",
              "enum": [
                "left",
                "center",
                "right"
              ],
              "type": "string"
            },
            "backing": {
              "default": false,
              "type": "boolean"
            },
            "color": {
              "default": "#ffffff",
              "pattern": "^#[\\da-fA-F]{6}$",
              "type": "string"
            },
            "font": {
              "default": "script",
              "enum": [
                "script",
                "serif",
                "sans"
              ],
              "type": "string"
            },
            "logoAssetId": {
              "default": null,
              "format": "uuid",
              "nullable": true,
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
              "type": "string"
            },
            "logoPosition": {
              "default": "above",
              "enum": [
                "above",
                "below",
                "left",
                "right"
              ],
              "type": "string"
            },
            "logoScale": {
              "default": 1,
              "maximum": 4,
              "minimum": 0.25,
              "type": "number"
            },
            "logoVariant": {
              "default": "original",
              "enum": [
                "original",
                "light",
                "dark"
              ],
              "type": "string"
            },
            "margin": {
              "default": 4,
              "maximum": 25,
              "minimum": 0,
              "type": "number"
            },
            "opacity": {
              "default": 45,
              "maximum": 100,
              "minimum": 1,
              "type": "number"
            },
            "outline": {
              "default": false,
              "type": "boolean"
            },
            "pattern": {
              "default": "signature",
              "enum": [
                "signature",
                "centre",
                "diagonal",
                "tile"
              ],
              "type": "string"
            },
            "position": {
              "default": "bottom-right",
              "enum": [
                "top-left",
                "top-right",
                "bottom-left",
                "bottom-right",
                "center"
              ],
              "type": "string"
            },
            "rotation": {
              "default": 0,
              "maximum": 180,
              "minimum": -180,
              "type": "number"
            },
            "secondLine": {
              "default": "",
              "maxLength": 200,
              "type": "string"
            },
            "size": {
              "default": 6,
              "maximum": 30,
              "minimum": 1,
              "type": "number"
            },
            "spacing": {
              "default": 6,
              "maximum": 100,
              "minimum": 0,
              "type": "number"
            },
            "text": {
              "maxLength": 200,
              "minLength": 1,
              "type": "string"
            },
            "type": {
              "default": "text",
              "enum": [
                "text",
                "logo",
                "both"
              ],
              "type": "string"
            }
          },
          "required": [
            "text"
          ],
          "type": "object"
        },
        "selectionDeadline": {
          "format": "date-time",
          "nullable": true,
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
          "type": "string"
        },
        "terms": {
          "maxLength": 5000,
          "type": "string"
        },
        "title": {
          "maxLength": 200,
          "minLength": 1,
          "type": "string"
        },
        "turnaroundDays": {
          "maximum": 365,
          "minimum": 0,
          "type": "integer"
        },
        "webWatermark": {
          "additionalProperties": false,
          "nullable": true,
          "properties": {
            "alignment": {
              "default": "center",
              "enum": [
                "left",
                "center",
                "right"
              ],
              "type": "string"
            },
            "backing": {
              "default": false,
              "type": "boolean"
            },
            "color": {
              "default": "#ffffff",
              "pattern": "^#[\\da-fA-F]{6}$",
              "type": "string"
            },
            "font": {
              "default": "script",
              "enum": [
                "script",
                "serif",
                "sans"
              ],
              "type": "string"
            },
            "logoAssetId": {
              "default": null,
              "format": "uuid",
              "nullable": true,
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
              "type": "string"
            },
            "logoPosition": {
              "default": "above",
              "enum": [
                "above",
                "below",
                "left",
                "right"
              ],
              "type": "string"
            },
            "logoScale": {
              "default": 1,
              "maximum": 4,
              "minimum": 0.25,
              "type": "number"
            },
            "logoVariant": {
              "default": "original",
              "enum": [
                "original",
                "light",
                "dark"
              ],
              "type": "string"
            },
            "margin": {
              "default": 4,
              "maximum": 25,
              "minimum": 0,
              "type": "number"
            },
            "opacity": {
              "default": 45,
              "maximum": 100,
              "minimum": 1,
              "type": "number"
            },
            "outline": {
              "default": false,
              "type": "boolean"
            },
            "pattern": {
              "default": "signature",
              "enum": [
                "signature",
                "centre",
                "diagonal",
                "tile"
              ],
              "type": "string"
            },
            "position": {
              "default": "bottom-right",
              "enum": [
                "top-left",
                "top-right",
                "bottom-left",
                "bottom-right",
                "center"
              ],
              "type": "string"
            },
            "rotation": {
              "default": 0,
              "maximum": 180,
              "minimum": -180,
              "type": "number"
            },
            "secondLine": {
              "default": "",
              "maxLength": 200,
              "type": "string"
            },
            "size": {
              "default": 6,
              "maximum": 30,
              "minimum": 1,
              "type": "number"
            },
            "spacing": {
              "default": 6,
              "maximum": 100,
              "minimum": 0,
              "type": "number"
            },
            "text": {
              "maxLength": 200,
              "minLength": 1,
              "type": "string"
            },
            "type": {
              "default": "text",
              "enum": [
                "text",
                "logo",
                "both"
              ],
              "type": "string"
            }
          },
          "required": [
            "text"
          ],
          "type": "object"
        }
      },
      "required": [
        "presentation",
        "title",
        "mode",
        "paymentTiming",
        "currency",
        "includedCount",
        "additionalPrice",
        "collectionPrice",
        "bundles",
        "terms",
        "selectionDeadline",
        "expiresAt",
        "turnaroundDays",
        "proofWatermark",
        "webWatermark",
        "downloadWatermark"
      ],
      "type": "object"
    },
    "ordering": {
      "enum": [
        "chronological",
        "photographer",
        "manual",
        "chapters"
      ],
      "type": "string"
    },
    "orders": {
      "items": {
        "properties": {
          "acceptedAt": {
            "nullable": true,
            "type": "string"
          },
          "captureIds": {
            "items": {
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
              "type": "string"
            },
            "maxItems": 10000,
            "type": "array"
          },
          "createdAt": {
            "type": "string"
          },
          "currency": {
            "type": "string"
          },
          "editingBlocked": {
            "type": "boolean"
          },
          "id": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "items": {
            "items": {
              "properties": {
                "approved": {
                  "type": "boolean"
                },
                "captureId": {
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                  "type": "string"
                },
                "clientApprovalRequired": {
                  "type": "boolean"
                },
                "exportSpec": {
                  "properties": {
                    "format": {
                      "enum": [
                        "jpeg"
                      ],
                      "type": "string"
                    },
                    "maxEdge": {
                      "maximum": 65535,
                      "minimum": 320,
                      "type": "integer"
                    },
                    "quality": {
                      "enum": [
                        90
                      ],
                      "type": "number"
                    }
                  },
                  "required": [
                    "format",
                    "quality",
                    "maxEdge"
                  ],
                  "type": "object"
                },
                "outputs": {
                  "items": {
                    "properties": {
                      "approvalPreviewUrl": {
                        "nullable": true,
                        "type": "string"
                      },
                      "approved": {
                        "type": "boolean"
                      },
                      "blockedReason": {
                        "enum": [
                          "permission",
                          "order",
                          "payment",
                          "approval",
                          "render"
                        ],
                        "nullable": true,
                        "type": "string"
                      },
                      "branded": {
                        "type": "boolean"
                      },
                      "canDownload": {
                        "type": "boolean"
                      },
                      "clientApprovalRequired": {
                        "type": "boolean"
                      },
                      "exportSpec": {
                        "properties": {
                          "format": {
                            "enum": [
                              "jpeg"
                            ],
                            "type": "string"
                          },
                          "maxEdge": {
                            "maximum": 65535,
                            "minimum": 320,
                            "type": "integer"
                          },
                          "quality": {
                            "enum": [
                              90
                            ],
                            "type": "number"
                          }
                        },
                        "required": [
                          "format",
                          "quality",
                          "maxEdge"
                        ],
                        "type": "object"
                      },
                      "id": {
                        "format": "uuid",
                        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                        "type": "string"
                      },
                      "kind": {
                        "enum": [
                          "print",
                          "web",
                          "social"
                        ],
                        "type": "string"
                      },
                      "label": {
                        "type": "string"
                      },
                      "ready": {
                        "type": "boolean"
                      },
                      "renderStatus": {
                        "enum": [
                          "awaiting-approval",
                          "preparing",
                          "ready"
                        ],
                        "type": "string"
                      },
                      "revisionId": {
                        "format": "uuid",
                        "nullable": true,
                        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                        "type": "string"
                      },
                      "url": {
                        "type": "string"
                      }
                    },
                    "required": [
                      "id",
                      "label",
                      "kind",
                      "revisionId",
                      "approved",
                      "clientApprovalRequired",
                      "ready",
                      "renderStatus",
                      "branded",
                      "approvalPreviewUrl",
                      "exportSpec",
                      "url"
                    ],
                    "type": "object"
                  },
                  "type": "array"
                },
                "ready": {
                  "type": "boolean"
                },
                "revisionId": {
                  "format": "uuid",
                  "nullable": true,
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                  "type": "string"
                }
              },
              "required": [
                "captureId",
                "revisionId",
                "approved",
                "clientApprovalRequired",
                "ready",
                "exportSpec",
                "outputs"
              ],
              "type": "object"
            },
            "type": "array"
          },
          "paymentTiming": {
            "enum": [
              "before-editing",
              "after-approval"
            ],
            "type": "string"
          },
          "pricing": {
            "properties": {
              "additionalPrice": {
                "maximum": 100000000,
                "minimum": 0,
                "type": "integer"
              },
              "bundles": {
                "items": {
                  "additionalProperties": false,
                  "properties": {
                    "count": {
                      "maximum": 10000,
                      "minimum": 1,
                      "type": "integer"
                    },
                    "price": {
                      "maximum": 100000000,
                      "minimum": 0,
                      "type": "integer"
                    }
                  },
                  "required": [
                    "count",
                    "price"
                  ],
                  "type": "object"
                },
                "maxItems": 20,
                "type": "array"
              },
              "collectionPrice": {
                "maximum": 100000000,
                "minimum": 0,
                "nullable": true,
                "type": "integer"
              },
              "includedCount": {
                "maximum": 9007199254740991,
                "minimum": -9007199254740991,
                "type": "integer"
              },
              "option": {
                "type": "string"
              }
            },
            "required": [
              "includedCount",
              "additionalPrice",
              "collectionPrice",
              "bundles",
              "option"
            ],
            "type": "object"
          },
          "readyCount": {
            "maximum": 9007199254740991,
            "minimum": -9007199254740991,
            "type": "integer"
          },
          "recipientId": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "roundId": {
            "format": "uuid",
            "nullable": true,
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "status": {
            "enum": [
              "quoted",
              "accepted",
              "settled",
              "free",
              "refunded",
              "cancelled"
            ],
            "type": "string"
          },
          "terms": {
            "type": "string"
          },
          "total": {
            "maximum": 100000000,
            "minimum": 0,
            "type": "integer"
          }
        },
        "required": [
          "id",
          "recipientId",
          "roundId",
          "status",
          "currency",
          "total",
          "captureIds",
          "terms",
          "paymentTiming",
          "pricing",
          "createdAt",
          "acceptedAt",
          "items",
          "readyCount",
          "editingBlocked"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "pendingEdits": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "presets": {
      "items": {
        "properties": {
          "config": {
            "additionalProperties": false,
            "properties": {
              "additionalPrice": {
                "maximum": 100000000,
                "minimum": 0,
                "type": "integer"
              },
              "bundles": {
                "items": {
                  "additionalProperties": false,
                  "properties": {
                    "count": {
                      "maximum": 10000,
                      "minimum": 1,
                      "type": "integer"
                    },
                    "price": {
                      "maximum": 100000000,
                      "minimum": 0,
                      "type": "integer"
                    }
                  },
                  "required": [
                    "count",
                    "price"
                  ],
                  "type": "object"
                },
                "maxItems": 20,
                "type": "array"
              },
              "collectionPrice": {
                "maximum": 100000000,
                "minimum": 0,
                "nullable": true,
                "type": "integer"
              },
              "currency": {
                "pattern": "^[A-Z]{3}$",
                "type": "string"
              },
              "downloadOutputs": {
                "items": {
                  "additionalProperties": false,
                  "properties": {
                    "key": {
                      "pattern": "^[a-z][a-z0-9-]{0,39}$",
                      "type": "string"
                    },
                    "kind": {
                      "enum": [
                        "print",
                        "web",
                        "social"
                      ],
                      "type": "string"
                    },
                    "label": {
                      "maxLength": 100,
                      "minLength": 1,
                      "type": "string"
                    },
                    "maxEdge": {
                      "maximum": 65535,
                      "minimum": 320,
                      "type": "integer"
                    },
                    "watermark": {
                      "additionalProperties": false,
                      "nullable": true,
                      "properties": {
                        "alignment": {
                          "default": "center",
                          "enum": [
                            "left",
                            "center",
                            "right"
                          ],
                          "type": "string"
                        },
                        "backing": {
                          "default": false,
                          "type": "boolean"
                        },
                        "color": {
                          "default": "#ffffff",
                          "pattern": "^#[\\da-fA-F]{6}$",
                          "type": "string"
                        },
                        "font": {
                          "default": "script",
                          "enum": [
                            "script",
                            "serif",
                            "sans"
                          ],
                          "type": "string"
                        },
                        "logoAssetId": {
                          "default": null,
                          "format": "uuid",
                          "nullable": true,
                          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                          "type": "string"
                        },
                        "logoPosition": {
                          "default": "above",
                          "enum": [
                            "above",
                            "below",
                            "left",
                            "right"
                          ],
                          "type": "string"
                        },
                        "logoScale": {
                          "default": 1,
                          "maximum": 4,
                          "minimum": 0.25,
                          "type": "number"
                        },
                        "logoVariant": {
                          "default": "original",
                          "enum": [
                            "original",
                            "light",
                            "dark"
                          ],
                          "type": "string"
                        },
                        "margin": {
                          "default": 4,
                          "maximum": 25,
                          "minimum": 0,
                          "type": "number"
                        },
                        "opacity": {
                          "default": 45,
                          "maximum": 100,
                          "minimum": 1,
                          "type": "number"
                        },
                        "outline": {
                          "default": false,
                          "type": "boolean"
                        },
                        "pattern": {
                          "default": "signature",
                          "enum": [
                            "signature",
                            "centre",
                            "diagonal",
                            "tile"
                          ],
                          "type": "string"
                        },
                        "position": {
                          "default": "bottom-right",
                          "enum": [
                            "top-left",
                            "top-right",
                            "bottom-left",
                            "bottom-right",
                            "center"
                          ],
                          "type": "string"
                        },
                        "rotation": {
                          "default": 0,
                          "maximum": 180,
                          "minimum": -180,
                          "type": "number"
                        },
                        "secondLine": {
                          "default": "",
                          "maxLength": 200,
                          "type": "string"
                        },
                        "size": {
                          "default": 6,
                          "maximum": 30,
                          "minimum": 1,
                          "type": "number"
                        },
                        "spacing": {
                          "default": 6,
                          "maximum": 100,
                          "minimum": 0,
                          "type": "number"
                        },
                        "text": {
                          "maxLength": 200,
                          "minLength": 1,
                          "type": "string"
                        },
                        "type": {
                          "default": "text",
                          "enum": [
                            "text",
                            "logo",
                            "both"
                          ],
                          "type": "string"
                        }
                      },
                      "required": [
                        "text"
                      ],
                      "type": "object"
                    }
                  },
                  "required": [
                    "key",
                    "label",
                    "kind",
                    "maxEdge",
                    "watermark"
                  ],
                  "type": "object"
                },
                "maxItems": 6,
                "minItems": 1,
                "type": "array"
              },
              "downloadWatermark": {
                "additionalProperties": false,
                "nullable": true,
                "properties": {
                  "alignment": {
                    "default": "center",
                    "enum": [
                      "left",
                      "center",
                      "right"
                    ],
                    "type": "string"
                  },
                  "backing": {
                    "default": false,
                    "type": "boolean"
                  },
                  "color": {
                    "default": "#ffffff",
                    "pattern": "^#[\\da-fA-F]{6}$",
                    "type": "string"
                  },
                  "font": {
                    "default": "script",
                    "enum": [
                      "script",
                      "serif",
                      "sans"
                    ],
                    "type": "string"
                  },
                  "logoAssetId": {
                    "default": null,
                    "format": "uuid",
                    "nullable": true,
                    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                    "type": "string"
                  },
                  "logoPosition": {
                    "default": "above",
                    "enum": [
                      "above",
                      "below",
                      "left",
                      "right"
                    ],
                    "type": "string"
                  },
                  "logoScale": {
                    "default": 1,
                    "maximum": 4,
                    "minimum": 0.25,
                    "type": "number"
                  },
                  "logoVariant": {
                    "default": "original",
                    "enum": [
                      "original",
                      "light",
                      "dark"
                    ],
                    "type": "string"
                  },
                  "margin": {
                    "default": 4,
                    "maximum": 25,
                    "minimum": 0,
                    "type": "number"
                  },
                  "opacity": {
                    "default": 45,
                    "maximum": 100,
                    "minimum": 1,
                    "type": "number"
                  },
                  "outline": {
                    "default": false,
                    "type": "boolean"
                  },
                  "pattern": {
                    "default": "signature",
                    "enum": [
                      "signature",
                      "centre",
                      "diagonal",
                      "tile"
                    ],
                    "type": "string"
                  },
                  "position": {
                    "default": "bottom-right",
                    "enum": [
                      "top-left",
                      "top-right",
                      "bottom-left",
                      "bottom-right",
                      "center"
                    ],
                    "type": "string"
                  },
                  "rotation": {
                    "default": 0,
                    "maximum": 180,
                    "minimum": -180,
                    "type": "number"
                  },
                  "secondLine": {
                    "default": "",
                    "maxLength": 200,
                    "type": "string"
                  },
                  "size": {
                    "default": 6,
                    "maximum": 30,
                    "minimum": 1,
                    "type": "number"
                  },
                  "spacing": {
                    "default": 6,
                    "maximum": 100,
                    "minimum": 0,
                    "type": "number"
                  },
                  "text": {
                    "maxLength": 200,
                    "minLength": 1,
                    "type": "string"
                  },
                  "type": {
                    "default": "text",
                    "enum": [
                      "text",
                      "logo",
                      "both"
                    ],
                    "type": "string"
                  }
                },
                "required": [
                  "text"
                ],
                "type": "object"
              },
              "expiresAt": {
                "format": "date-time",
                "nullable": true,
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
                "type": "string"
              },
              "includedCount": {
                "maximum": 10000,
                "minimum": 0,
                "type": "integer"
              },
              "mode": {
                "enum": [
                  "edited-delivery",
                  "select-before-editing",
                  "sell-by-photo"
                ],
                "type": "string"
              },
              "paymentTiming": {
                "enum": [
                  "before-editing",
                  "after-approval"
                ],
                "type": "string"
              },
              "presentation": {
                "additionalProperties": false,
                "properties": {
                  "blocks": {
                    "items": {
                      "additionalProperties": false,
                      "properties": {
                        "captureIds": {
                          "items": {
                            "format": "uuid",
                            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                            "type": "string"
                          },
                          "maxItems": 1000,
                          "type": "array"
                        },
                        "chapterId": {
                          "format": "uuid",
                          "nullable": true,
                          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                          "type": "string"
                        },
                        "id": {
                          "format": "uuid",
                          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                          "type": "string"
                        },
                        "selection": {
                          "enum": [
                            "automatic",
                            "explicit"
                          ],
                          "type": "string"
                        },
                        "text": {
                          "maxLength": 2000,
                          "type": "string"
                        },
                        "type": {
                          "enum": [
                            "chapter",
                            "grid",
                            "full",
                            "pair",
                            "caption",
                            "slideshow"
                          ],
                          "type": "string"
                        }
                      },
                      "required": [
                        "id",
                        "type",
                        "chapterId",
                        "captureIds",
                        "text"
                      ],
                      "type": "object"
                    },
                    "maxItems": 100,
                    "type": "array"
                  },
                  "coverCaptureId": {
                    "format": "uuid",
                    "nullable": true,
                    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                    "type": "string"
                  },
                  "coverFocal": {
                    "maximum": 100,
                    "minimum": 0,
                    "type": "number"
                  },
                  "coverTreatment": {
                    "enum": [
                      "full",
                      "split",
                      "quiet"
                    ],
                    "type": "string"
                  },
                  "font": {
                    "enum": [
                      "editorial",
                      "modern",
                      "script"
                    ],
                    "type": "string"
                  },
                  "introduction": {
                    "maxLength": 5000,
                    "type": "string"
                  },
                  "palette": {
                    "enum": [
                      "studio",
                      "ivory",
                      "charcoal"
                    ],
                    "type": "string"
                  },
                  "showChapters": {
                    "type": "boolean"
                  },
                  "showNumbers": {
                    "type": "boolean"
                  },
                  "spacing": {
                    "enum": [
                      "compact",
                      "comfortable",
                      "airy"
                    ],
                    "type": "string"
                  },
                  "template": {
                    "enum": [
                      "wedding",
                      "portrait",
                      "fine-art",
                      "proofing"
                    ],
                    "type": "string"
                  }
                },
                "required": [
                  "template",
                  "coverCaptureId",
                  "coverTreatment",
                  "coverFocal",
                  "font",
                  "palette",
                  "spacing",
                  "introduction",
                  "showChapters",
                  "showNumbers"
                ],
                "type": "object"
              },
              "proofWatermark": {
                "additionalProperties": false,
                "properties": {
                  "alignment": {
                    "default": "center",
                    "enum": [
                      "left",
                      "center",
                      "right"
                    ],
                    "type": "string"
                  },
                  "backing": {
                    "default": false,
                    "type": "boolean"
                  },
                  "color": {
                    "default": "#ffffff",
                    "pattern": "^#[\\da-fA-F]{6}$",
                    "type": "string"
                  },
                  "font": {
                    "default": "script",
                    "enum": [
                      "script",
                      "serif",
                      "sans"
                    ],
                    "type": "string"
                  },
                  "logoAssetId": {
                    "default": null,
                    "format": "uuid",
                    "nullable": true,
                    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                    "type": "string"
                  },
                  "logoPosition": {
                    "default": "above",
                    "enum": [
                      "above",
                      "below",
                      "left",
                      "right"
                    ],
                    "type": "string"
                  },
                  "logoScale": {
                    "default": 1,
                    "maximum": 4,
                    "minimum": 0.25,
                    "type": "number"
                  },
                  "logoVariant": {
                    "default": "original",
                    "enum": [
                      "original",
                      "light",
                      "dark"
                    ],
                    "type": "string"
                  },
                  "margin": {
                    "default": 4,
                    "maximum": 25,
                    "minimum": 0,
                    "type": "number"
                  },
                  "opacity": {
                    "default": 45,
                    "maximum": 100,
                    "minimum": 1,
                    "type": "number"
                  },
                  "outline": {
                    "default": false,
                    "type": "boolean"
                  },
                  "pattern": {
                    "default": "signature",
                    "enum": [
                      "signature",
                      "centre",
                      "diagonal",
                      "tile"
                    ],
                    "type": "string"
                  },
                  "position": {
                    "default": "bottom-right",
                    "enum": [
                      "top-left",
                      "top-right",
                      "bottom-left",
                      "bottom-right",
                      "center"
                    ],
                    "type": "string"
                  },
                  "rotation": {
                    "default": 0,
                    "maximum": 180,
                    "minimum": -180,
                    "type": "number"
                  },
                  "secondLine": {
                    "default": "",
                    "maxLength": 200,
                    "type": "string"
                  },
                  "size": {
                    "default": 6,
                    "maximum": 30,
                    "minimum": 1,
                    "type": "number"
                  },
                  "spacing": {
                    "default": 6,
                    "maximum": 100,
                    "minimum": 0,
                    "type": "number"
                  },
                  "text": {
                    "maxLength": 200,
                    "minLength": 1,
                    "type": "string"
                  },
                  "type": {
                    "default": "text",
                    "enum": [
                      "text",
                      "logo",
                      "both"
                    ],
                    "type": "string"
                  }
                },
                "required": [
                  "text"
                ],
                "type": "object"
              },
              "selectionDeadline": {
                "format": "date-time",
                "nullable": true,
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
                "type": "string"
              },
              "terms": {
                "maxLength": 5000,
                "type": "string"
              },
              "title": {
                "maxLength": 200,
                "minLength": 1,
                "type": "string"
              },
              "turnaroundDays": {
                "maximum": 365,
                "minimum": 0,
                "type": "integer"
              },
              "webWatermark": {
                "additionalProperties": false,
                "nullable": true,
                "properties": {
                  "alignment": {
                    "default": "center",
                    "enum": [
                      "left",
                      "center",
                      "right"
                    ],
                    "type": "string"
                  },
                  "backing": {
                    "default": false,
                    "type": "boolean"
                  },
                  "color": {
                    "default": "#ffffff",
                    "pattern": "^#[\\da-fA-F]{6}$",
                    "type": "string"
                  },
                  "font": {
                    "default": "script",
                    "enum": [
                      "script",
                      "serif",
                      "sans"
                    ],
                    "type": "string"
                  },
                  "logoAssetId": {
                    "default": null,
                    "format": "uuid",
                    "nullable": true,
                    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                    "type": "string"
                  },
                  "logoPosition": {
                    "default": "above",
                    "enum": [
                      "above",
                      "below",
                      "left",
                      "right"
                    ],
                    "type": "string"
                  },
                  "logoScale": {
                    "default": 1,
                    "maximum": 4,
                    "minimum": 0.25,
                    "type": "number"
                  },
                  "logoVariant": {
                    "default": "original",
                    "enum": [
                      "original",
                      "light",
                      "dark"
                    ],
                    "type": "string"
                  },
                  "margin": {
                    "default": 4,
                    "maximum": 25,
                    "minimum": 0,
                    "type": "number"
                  },
                  "opacity": {
                    "default": 45,
                    "maximum": 100,
                    "minimum": 1,
                    "type": "number"
                  },
                  "outline": {
                    "default": false,
                    "type": "boolean"
                  },
                  "pattern": {
                    "default": "signature",
                    "enum": [
                      "signature",
                      "centre",
                      "diagonal",
                      "tile"
                    ],
                    "type": "string"
                  },
                  "position": {
                    "default": "bottom-right",
                    "enum": [
                      "top-left",
                      "top-right",
                      "bottom-left",
                      "bottom-right",
                      "center"
                    ],
                    "type": "string"
                  },
                  "rotation": {
                    "default": 0,
                    "maximum": 180,
                    "minimum": -180,
                    "type": "number"
                  },
                  "secondLine": {
                    "default": "",
                    "maxLength": 200,
                    "type": "string"
                  },
                  "size": {
                    "default": 6,
                    "maximum": 30,
                    "minimum": 1,
                    "type": "number"
                  },
                  "spacing": {
                    "default": 6,
                    "maximum": 100,
                    "minimum": 0,
                    "type": "number"
                  },
                  "text": {
                    "maxLength": 200,
                    "minLength": 1,
                    "type": "string"
                  },
                  "type": {
                    "default": "text",
                    "enum": [
                      "text",
                      "logo",
                      "both"
                    ],
                    "type": "string"
                  }
                },
                "required": [
                  "text"
                ],
                "type": "object"
              }
            },
            "required": [
              "presentation",
              "title",
              "mode",
              "paymentTiming",
              "currency",
              "includedCount",
              "additionalPrice",
              "collectionPrice",
              "bundles",
              "terms",
              "selectionDeadline",
              "expiresAt",
              "turnaroundDays",
              "proofWatermark",
              "webWatermark",
              "downloadWatermark"
            ],
            "type": "object"
          },
          "id": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "id",
          "name",
          "config"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "publication": {
      "nullable": true,
      "properties": {
        "completed": {
          "maximum": 9007199254740991,
          "minimum": -9007199254740991,
          "type": "integer"
        },
        "error": {
          "nullable": true,
          "type": "string"
        },
        "failedCaptureId": {
          "format": "uuid",
          "nullable": true,
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
          "type": "string"
        },
        "id": {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
          "type": "string"
        },
        "status": {
          "enum": [
            "queued",
            "rendering",
            "ready",
            "failed"
          ],
          "type": "string"
        },
        "total": {
          "maximum": 9007199254740991,
          "minimum": -9007199254740991,
          "type": "integer"
        }
      },
      "required": [
        "id",
        "status",
        "completed",
        "total",
        "error",
        "failedCaptureId"
      ],
      "type": "object"
    },
    "receipts": {
      "items": {
        "properties": {
          "action": {
            "type": "string"
          },
          "createdAt": {
            "type": "string"
          },
          "id": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "orderId": {
            "format": "uuid",
            "nullable": true,
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "recipientId": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "reference": {
            "type": "string"
          }
        },
        "required": [
          "id",
          "orderId",
          "recipientId",
          "action",
          "reference",
          "createdAt"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "recipients": {
      "items": {
        "properties": {
          "canDownload": {
            "type": "boolean"
          },
          "canProof": {
            "type": "boolean"
          },
          "captureIds": {
            "items": {
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
              "type": "string"
            },
            "maxItems": 10000,
            "nullable": true,
            "type": "array"
          },
          "choices": {
            "items": {
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
              "type": "string"
            },
            "maxItems": 10000,
            "type": "array"
          },
          "expiresAt": {
            "format": "date-time",
            "nullable": true,
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
            "type": "string"
          },
          "id": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "notes": {
            "items": {
              "additionalProperties": false,
              "properties": {
                "annotations": {
                  "items": {
                    "additionalProperties": false,
                    "properties": {
                      "height": {
                        "maximum": 1,
                        "minimum": 0,
                        "type": "number"
                      },
                      "text": {
                        "maxLength": 500,
                        "type": "string"
                      },
                      "width": {
                        "maximum": 1,
                        "minimum": 0,
                        "type": "number"
                      },
                      "x": {
                        "maximum": 1,
                        "minimum": 0,
                        "type": "number"
                      },
                      "y": {
                        "maximum": 1,
                        "minimum": 0,
                        "type": "number"
                      }
                    },
                    "required": [
                      "x",
                      "y",
                      "width",
                      "height",
                      "text"
                    ],
                    "type": "object"
                  },
                  "maxItems": 20,
                  "type": "array"
                },
                "captureId": {
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                  "type": "string"
                },
                "text": {
                  "maxLength": 2000,
                  "type": "string"
                }
              },
              "required": [
                "captureId",
                "text"
              ],
              "type": "object"
            },
            "type": "array"
          },
          "passwordProtected": {
            "type": "boolean"
          },
          "revoked": {
            "type": "boolean"
          }
        },
        "required": [
          "id",
          "name",
          "revoked",
          "expiresAt",
          "canProof",
          "canDownload",
          "captureIds",
          "choices",
          "notes",
          "passwordProtected"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "revision": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "rounds": {
      "items": {
        "properties": {
          "captureIds": {
            "items": {
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
              "type": "string"
            },
            "maxItems": 10000,
            "type": "array"
          },
          "createdAt": {
            "type": "string"
          },
          "id": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "notes": {
            "items": {
              "additionalProperties": false,
              "properties": {
                "annotations": {
                  "items": {
                    "additionalProperties": false,
                    "properties": {
                      "height": {
                        "maximum": 1,
                        "minimum": 0,
                        "type": "number"
                      },
                      "text": {
                        "maxLength": 500,
                        "type": "string"
                      },
                      "width": {
                        "maximum": 1,
                        "minimum": 0,
                        "type": "number"
                      },
                      "x": {
                        "maximum": 1,
                        "minimum": 0,
                        "type": "number"
                      },
                      "y": {
                        "maximum": 1,
                        "minimum": 0,
                        "type": "number"
                      }
                    },
                    "required": [
                      "x",
                      "y",
                      "width",
                      "height",
                      "text"
                    ],
                    "type": "object"
                  },
                  "maxItems": 20,
                  "type": "array"
                },
                "captureId": {
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                  "type": "string"
                },
                "text": {
                  "maxLength": 2000,
                  "type": "string"
                }
              },
              "required": [
                "captureId",
                "text"
              ],
              "type": "object"
            },
            "type": "array"
          },
          "number": {
            "maximum": 9007199254740991,
            "minimum": -9007199254740991,
            "type": "integer"
          },
          "recipientId": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          }
        },
        "required": [
          "id",
          "recipientId",
          "number",
          "captureIds",
          "notes",
          "createdAt"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "shootId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "studioPresets": {
      "properties": {
        "presets": {
          "items": {
            "properties": {
              "config": {
                "additionalProperties": false,
                "properties": {
                  "additionalPrice": {
                    "maximum": 100000000,
                    "minimum": 0,
                    "type": "integer"
                  },
                  "bundles": {
                    "items": {
                      "additionalProperties": false,
                      "properties": {
                        "count": {
                          "maximum": 10000,
                          "minimum": 1,
                          "type": "integer"
                        },
                        "price": {
                          "maximum": 100000000,
                          "minimum": 0,
                          "type": "integer"
                        }
                      },
                      "required": [
                        "count",
                        "price"
                      ],
                      "type": "object"
                    },
                    "maxItems": 20,
                    "type": "array"
                  },
                  "collectionPrice": {
                    "maximum": 100000000,
                    "minimum": 0,
                    "nullable": true,
                    "type": "integer"
                  },
                  "currency": {
                    "pattern": "^[A-Z]{3}$",
                    "type": "string"
                  },
                  "downloadOutputs": {
                    "items": {
                      "additionalProperties": false,
                      "properties": {
                        "key": {
                          "pattern": "^[a-z][a-z0-9-]{0,39}$",
                          "type": "string"
                        },
                        "kind": {
                          "enum": [
                            "print",
                            "web",
                            "social"
                          ],
                          "type": "string"
                        },
                        "label": {
                          "maxLength": 100,
                          "minLength": 1,
                          "type": "string"
                        },
                        "maxEdge": {
                          "maximum": 65535,
                          "minimum": 320,
                          "type": "integer"
                        },
                        "watermark": {
                          "additionalProperties": false,
                          "nullable": true,
                          "properties": {
                            "alignment": {
                              "default": "center",
                              "enum": [
                                "left",
                                "center",
                                "right"
                              ],
                              "type": "string"
                            },
                            "backing": {
                              "default": false,
                              "type": "boolean"
                            },
                            "color": {
                              "default": "#ffffff",
                              "pattern": "^#[\\da-fA-F]{6}$",
                              "type": "string"
                            },
                            "font": {
                              "default": "script",
                              "enum": [
                                "script",
                                "serif",
                                "sans"
                              ],
                              "type": "string"
                            },
                            "logoAssetId": {
                              "default": null,
                              "format": "uuid",
                              "nullable": true,
                              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                              "type": "string"
                            },
                            "logoPosition": {
                              "default": "above",
                              "enum": [
                                "above",
                                "below",
                                "left",
                                "right"
                              ],
                              "type": "string"
                            },
                            "logoScale": {
                              "default": 1,
                              "maximum": 4,
                              "minimum": 0.25,
                              "type": "number"
                            },
                            "logoVariant": {
                              "default": "original",
                              "enum": [
                                "original",
                                "light",
                                "dark"
                              ],
                              "type": "string"
                            },
                            "margin": {
                              "default": 4,
                              "maximum": 25,
                              "minimum": 0,
                              "type": "number"
                            },
                            "opacity": {
                              "default": 45,
                              "maximum": 100,
                              "minimum": 1,
                              "type": "number"
                            },
                            "outline": {
                              "default": false,
                              "type": "boolean"
                            },
                            "pattern": {
                              "default": "signature",
                              "enum": [
                                "signature",
                                "centre",
                                "diagonal",
                                "tile"
                              ],
                              "type": "string"
                            },
                            "position": {
                              "default": "bottom-right",
                              "enum": [
                                "top-left",
                                "top-right",
                                "bottom-left",
                                "bottom-right",
                                "center"
                              ],
                              "type": "string"
                            },
                            "rotation": {
                              "default": 0,
                              "maximum": 180,
                              "minimum": -180,
                              "type": "number"
                            },
                            "secondLine": {
                              "default": "",
                              "maxLength": 200,
                              "type": "string"
                            },
                            "size": {
                              "default": 6,
                              "maximum": 30,
                              "minimum": 1,
                              "type": "number"
                            },
                            "spacing": {
                              "default": 6,
                              "maximum": 100,
                              "minimum": 0,
                              "type": "number"
                            },
                            "text": {
                              "maxLength": 200,
                              "minLength": 1,
                              "type": "string"
                            },
                            "type": {
                              "default": "text",
                              "enum": [
                                "text",
                                "logo",
                                "both"
                              ],
                              "type": "string"
                            }
                          },
                          "required": [
                            "text"
                          ],
                          "type": "object"
                        }
                      },
                      "required": [
                        "key",
                        "label",
                        "kind",
                        "maxEdge",
                        "watermark"
                      ],
                      "type": "object"
                    },
                    "maxItems": 6,
                    "minItems": 1,
                    "type": "array"
                  },
                  "downloadWatermark": {
                    "additionalProperties": false,
                    "nullable": true,
                    "properties": {
                      "alignment": {
                        "default": "center",
                        "enum": [
                          "left",
                          "center",
                          "right"
                        ],
                        "type": "string"
                      },
                      "backing": {
                        "default": false,
                        "type": "boolean"
                      },
                      "color": {
                        "default": "#ffffff",
                        "pattern": "^#[\\da-fA-F]{6}$",
                        "type": "string"
                      },
                      "font": {
                        "default": "script",
                        "enum": [
                          "script",
                          "serif",
                          "sans"
                        ],
                        "type": "string"
                      },
                      "logoAssetId": {
                        "default": null,
                        "format": "uuid",
                        "nullable": true,
                        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                        "type": "string"
                      },
                      "logoPosition": {
                        "default": "above",
                        "enum": [
                          "above",
                          "below",
                          "left",
                          "right"
                        ],
                        "type": "string"
                      },
                      "logoScale": {
                        "default": 1,
                        "maximum": 4,
                        "minimum": 0.25,
                        "type": "number"
                      },
                      "logoVariant": {
                        "default": "original",
                        "enum": [
                          "original",
                          "light",
                          "dark"
                        ],
                        "type": "string"
                      },
                      "margin": {
                        "default": 4,
                        "maximum": 25,
                        "minimum": 0,
                        "type": "number"
                      },
                      "opacity": {
                        "default": 45,
                        "maximum": 100,
                        "minimum": 1,
                        "type": "number"
                      },
                      "outline": {
                        "default": false,
                        "type": "boolean"
                      },
                      "pattern": {
                        "default": "signature",
                        "enum": [
                          "signature",
                          "centre",
                          "diagonal",
                          "tile"
                        ],
                        "type": "string"
                      },
                      "position": {
                        "default": "bottom-right",
                        "enum": [
                          "top-left",
                          "top-right",
                          "bottom-left",
                          "bottom-right",
                          "center"
                        ],
                        "type": "string"
                      },
                      "rotation": {
                        "default": 0,
                        "maximum": 180,
                        "minimum": -180,
                        "type": "number"
                      },
                      "secondLine": {
                        "default": "",
                        "maxLength": 200,
                        "type": "string"
                      },
                      "size": {
                        "default": 6,
                        "maximum": 30,
                        "minimum": 1,
                        "type": "number"
                      },
                      "spacing": {
                        "default": 6,
                        "maximum": 100,
                        "minimum": 0,
                        "type": "number"
                      },
                      "text": {
                        "maxLength": 200,
                        "minLength": 1,
                        "type": "string"
                      },
                      "type": {
                        "default": "text",
                        "enum": [
                          "text",
                          "logo",
                          "both"
                        ],
                        "type": "string"
                      }
                    },
                    "required": [
                      "text"
                    ],
                    "type": "object"
                  },
                  "expiresAt": {
                    "format": "date-time",
                    "nullable": true,
                    "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
                    "type": "string"
                  },
                  "includedCount": {
                    "maximum": 10000,
                    "minimum": 0,
                    "type": "integer"
                  },
                  "mode": {
                    "enum": [
                      "edited-delivery",
                      "select-before-editing",
                      "sell-by-photo"
                    ],
                    "type": "string"
                  },
                  "paymentTiming": {
                    "enum": [
                      "before-editing",
                      "after-approval"
                    ],
                    "type": "string"
                  },
                  "presentation": {
                    "additionalProperties": false,
                    "properties": {
                      "blocks": {
                        "items": {
                          "additionalProperties": false,
                          "properties": {
                            "captureIds": {
                              "items": {
                                "format": "uuid",
                                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                                "type": "string"
                              },
                              "maxItems": 1000,
                              "type": "array"
                            },
                            "chapterId": {
                              "format": "uuid",
                              "nullable": true,
                              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                              "type": "string"
                            },
                            "id": {
                              "format": "uuid",
                              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                              "type": "string"
                            },
                            "selection": {
                              "enum": [
                                "automatic",
                                "explicit"
                              ],
                              "type": "string"
                            },
                            "text": {
                              "maxLength": 2000,
                              "type": "string"
                            },
                            "type": {
                              "enum": [
                                "chapter",
                                "grid",
                                "full",
                                "pair",
                                "caption",
                                "slideshow"
                              ],
                              "type": "string"
                            }
                          },
                          "required": [
                            "id",
                            "type",
                            "chapterId",
                            "captureIds",
                            "text"
                          ],
                          "type": "object"
                        },
                        "maxItems": 100,
                        "type": "array"
                      },
                      "coverCaptureId": {
                        "format": "uuid",
                        "nullable": true,
                        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                        "type": "string"
                      },
                      "coverFocal": {
                        "maximum": 100,
                        "minimum": 0,
                        "type": "number"
                      },
                      "coverTreatment": {
                        "enum": [
                          "full",
                          "split",
                          "quiet"
                        ],
                        "type": "string"
                      },
                      "font": {
                        "enum": [
                          "editorial",
                          "modern",
                          "script"
                        ],
                        "type": "string"
                      },
                      "introduction": {
                        "maxLength": 5000,
                        "type": "string"
                      },
                      "palette": {
                        "enum": [
                          "studio",
                          "ivory",
                          "charcoal"
                        ],
                        "type": "string"
                      },
                      "showChapters": {
                        "type": "boolean"
                      },
                      "showNumbers": {
                        "type": "boolean"
                      },
                      "spacing": {
                        "enum": [
                          "compact",
                          "comfortable",
                          "airy"
                        ],
                        "type": "string"
                      },
                      "template": {
                        "enum": [
                          "wedding",
                          "portrait",
                          "fine-art",
                          "proofing"
                        ],
                        "type": "string"
                      }
                    },
                    "required": [
                      "template",
                      "coverCaptureId",
                      "coverTreatment",
                      "coverFocal",
                      "font",
                      "palette",
                      "spacing",
                      "introduction",
                      "showChapters",
                      "showNumbers"
                    ],
                    "type": "object"
                  },
                  "proofWatermark": {
                    "additionalProperties": false,
                    "properties": {
                      "alignment": {
                        "default": "center",
                        "enum": [
                          "left",
                          "center",
                          "right"
                        ],
                        "type": "string"
                      },
                      "backing": {
                        "default": false,
                        "type": "boolean"
                      },
                      "color": {
                        "default": "#ffffff",
                        "pattern": "^#[\\da-fA-F]{6}$",
                        "type": "string"
                      },
                      "font": {
                        "default": "script",
                        "enum": [
                          "script",
                          "serif",
                          "sans"
                        ],
                        "type": "string"
                      },
                      "logoAssetId": {
                        "default": null,
                        "format": "uuid",
                        "nullable": true,
                        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                        "type": "string"
                      },
                      "logoPosition": {
                        "default": "above",
                        "enum": [
                          "above",
                          "below",
                          "left",
                          "right"
                        ],
                        "type": "string"
                      },
                      "logoScale": {
                        "default": 1,
                        "maximum": 4,
                        "minimum": 0.25,
                        "type": "number"
                      },
                      "logoVariant": {
                        "default": "original",
                        "enum": [
                          "original",
                          "light",
                          "dark"
                        ],
                        "type": "string"
                      },
                      "margin": {
                        "default": 4,
                        "maximum": 25,
                        "minimum": 0,
                        "type": "number"
                      },
                      "opacity": {
                        "default": 45,
                        "maximum": 100,
                        "minimum": 1,
                        "type": "number"
                      },
                      "outline": {
                        "default": false,
                        "type": "boolean"
                      },
                      "pattern": {
                        "default": "signature",
                        "enum": [
                          "signature",
                          "centre",
                          "diagonal",
                          "tile"
                        ],
                        "type": "string"
                      },
                      "position": {
                        "default": "bottom-right",
                        "enum": [
                          "top-left",
                          "top-right",
                          "bottom-left",
                          "bottom-right",
                          "center"
                        ],
                        "type": "string"
                      },
                      "rotation": {
                        "default": 0,
                        "maximum": 180,
                        "minimum": -180,
                        "type": "number"
                      },
                      "secondLine": {
                        "default": "",
                        "maxLength": 200,
                        "type": "string"
                      },
                      "size": {
                        "default": 6,
                        "maximum": 30,
                        "minimum": 1,
                        "type": "number"
                      },
                      "spacing": {
                        "default": 6,
                        "maximum": 100,
                        "minimum": 0,
                        "type": "number"
                      },
                      "text": {
                        "maxLength": 200,
                        "minLength": 1,
                        "type": "string"
                      },
                      "type": {
                        "default": "text",
                        "enum": [
                          "text",
                          "logo",
                          "both"
                        ],
                        "type": "string"
                      }
                    },
                    "required": [
                      "text"
                    ],
                    "type": "object"
                  },
                  "selectionDeadline": {
                    "format": "date-time",
                    "nullable": true,
                    "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
                    "type": "string"
                  },
                  "terms": {
                    "maxLength": 5000,
                    "type": "string"
                  },
                  "title": {
                    "maxLength": 200,
                    "minLength": 1,
                    "type": "string"
                  },
                  "turnaroundDays": {
                    "maximum": 365,
                    "minimum": 0,
                    "type": "integer"
                  },
                  "webWatermark": {
                    "additionalProperties": false,
                    "nullable": true,
                    "properties": {
                      "alignment": {
                        "default": "center",
                        "enum": [
                          "left",
                          "center",
                          "right"
                        ],
                        "type": "string"
                      },
                      "backing": {
                        "default": false,
                        "type": "boolean"
                      },
                      "color": {
                        "default": "#ffffff",
                        "pattern": "^#[\\da-fA-F]{6}$",
                        "type": "string"
                      },
                      "font": {
                        "default": "script",
                        "enum": [
                          "script",
                          "serif",
                          "sans"
                        ],
                        "type": "string"
                      },
                      "logoAssetId": {
                        "default": null,
                        "format": "uuid",
                        "nullable": true,
                        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                        "type": "string"
                      },
                      "logoPosition": {
                        "default": "above",
                        "enum": [
                          "above",
                          "below",
                          "left",
                          "right"
                        ],
                        "type": "string"
                      },
                      "logoScale": {
                        "default": 1,
                        "maximum": 4,
                        "minimum": 0.25,
                        "type": "number"
                      },
                      "logoVariant": {
                        "default": "original",
                        "enum": [
                          "original",
                          "light",
                          "dark"
                        ],
                        "type": "string"
                      },
                      "margin": {
                        "default": 4,
                        "maximum": 25,
                        "minimum": 0,
                        "type": "number"
                      },
                      "opacity": {
                        "default": 45,
                        "maximum": 100,
                        "minimum": 1,
                        "type": "number"
                      },
                      "outline": {
                        "default": false,
                        "type": "boolean"
                      },
                      "pattern": {
                        "default": "signature",
                        "enum": [
                          "signature",
                          "centre",
                          "diagonal",
                          "tile"
                        ],
                        "type": "string"
                      },
                      "position": {
                        "default": "bottom-right",
                        "enum": [
                          "top-left",
                          "top-right",
                          "bottom-left",
                          "bottom-right",
                          "center"
                        ],
                        "type": "string"
                      },
                      "rotation": {
                        "default": 0,
                        "maximum": 180,
                        "minimum": -180,
                        "type": "number"
                      },
                      "secondLine": {
                        "default": "",
                        "maxLength": 200,
                        "type": "string"
                      },
                      "size": {
                        "default": 6,
                        "maximum": 30,
                        "minimum": 1,
                        "type": "number"
                      },
                      "spacing": {
                        "default": 6,
                        "maximum": 100,
                        "minimum": 0,
                        "type": "number"
                      },
                      "text": {
                        "maxLength": 200,
                        "minLength": 1,
                        "type": "string"
                      },
                      "type": {
                        "default": "text",
                        "enum": [
                          "text",
                          "logo",
                          "both"
                        ],
                        "type": "string"
                      }
                    },
                    "required": [
                      "text"
                    ],
                    "type": "object"
                  }
                },
                "required": [
                  "presentation",
                  "title",
                  "mode",
                  "paymentTiming",
                  "currency",
                  "includedCount",
                  "additionalPrice",
                  "collectionPrice",
                  "bundles",
                  "terms",
                  "selectionDeadline",
                  "expiresAt",
                  "turnaroundDays",
                  "proofWatermark",
                  "webWatermark",
                  "downloadWatermark"
                ],
                "type": "object"
              },
              "id": {
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                "type": "string"
              },
              "name": {
                "type": "string"
              }
            },
            "required": [
              "id",
              "name",
              "config"
            ],
            "type": "object"
          },
          "type": "array"
        },
        "revision": {
          "format": "uuid",
          "nullable": true,
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        }
      },
      "required": [
        "revision",
        "presets"
      ],
      "type": "object"
    }
  },
  "required": [
    "approvals",
    "approvedVersions",
    "captures",
    "chapters",
    "config",
    "ordering",
    "orders",
    "pendingEdits",
    "presets",
    "publication",
    "receipts",
    "recipients",
    "revision",
    "rounds",
    "shootId",
    "studioPresets"
  ],
  "type": "object"
}
```
