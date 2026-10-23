export const ARCHIVE_LAYOUT = {
  "id": "archive",
  "title": "\u7b2c\u4e00\u5173 \u00b7 \u6863\u6848\u9986",
  "hall": "models/ArchiveHall",
  "bay": "models/ArchiveBay",
  "shelf_flip": false,
  "book": {
    "height": 0.24,
    "depth": 0.16,
    "thickness": 0.04,
    "origin": "bottom center; book space: spine toward -X, thickness along Z, height +Y"
  },
  "player_spawn": {
    "pos": [
      -2.5,
      0.0,
      0.0
    ],
    "facing": [
      1,
      0,
      0
    ]
  },
  "floors": [
    {
      "y": 0.0,
      "walk_zone_xz": [
        -6.65,
        6.65,
        -4.995,
        4.995
      ],
      "floor_zone_xz": [
        -5.4,
        3.24,
        -4.295,
        4.295
      ],
      "blockers": [
        {
          "name": "front_bookcase_L",
          "min_xz": [
            -7.0,
            -5.5
          ],
          "max_xz": [
            -6.61,
            -1.15
          ]
        },
        {
          "name": "front_bookcase_R",
          "min_xz": [
            -7.0,
            1.15
          ],
          "max_xz": [
            -6.61,
            5.5
          ]
        },
        {
          "name": "back_bookcase_R_inner",
          "min_xz": [
            6.61,
            0.95
          ],
          "max_xz": [
            7.0,
            2.05
          ]
        },
        {
          "name": "back_bookcase_R_outer",
          "min_xz": [
            6.61,
            3.95
          ],
          "max_xz": [
            7.0,
            5.5
          ]
        },
        {
          "name": "back_bookcase_L_inner",
          "min_xz": [
            6.61,
            -2.05
          ],
          "max_xz": [
            7.0,
            -0.95
          ]
        },
        {
          "name": "back_bookcase_L_outer",
          "min_xz": [
            6.61,
            -5.5
          ],
          "max_xz": [
            7.0,
            -3.95
          ]
        },
        {
          "name": "end_bookcase_left_front",
          "min_xz": [
            -6.64,
            -5.5
          ],
          "max_xz": [
            -5.5,
            -5.11
          ]
        },
        {
          "name": "end_bookcase_left_back",
          "min_xz": [
            5.5,
            -5.5
          ],
          "max_xz": [
            6.64,
            -5.11
          ]
        },
        {
          "name": "end_bookcase_right_back",
          "min_xz": [
            5.5,
            5.11
          ],
          "max_xz": [
            6.64,
            5.5
          ]
        },
        {
          "name": "end_bookcase_right_front",
          "min_xz": [
            -6.64,
            5.11
          ],
          "max_xz": [
            -5.5,
            5.5
          ]
        },
        {
          "name": "ladder_L",
          "min_xz": [
            3.348,
            -5.2981
          ],
          "max_xz": [
            3.852,
            -4.713
          ]
        },
        {
          "name": "ladder_R",
          "min_xz": [
            -3.852,
            4.713
          ],
          "max_xz": [
            -3.348,
            5.2981
          ]
        },
        {
          "name": "librarian_desk",
          "min_xz": [
            -6.26,
            2.06
          ],
          "max_xz": [
            -5.5,
            3.74
          ]
        },
        {
          "name": "desk_chair",
          "min_xz": [
            -6.655,
            2.485
          ],
          "max_xz": [
            -6.08,
            3.115
          ]
        },
        {
          "name": "card_cabinet",
          "min_xz": [
            -6.62,
            4.15
          ],
          "max_xz": [
            -6.22,
            4.87
          ]
        },
        {
          "name": "lectern",
          "min_xz": [
            -6.1802,
            -2.9
          ],
          "max_xz": [
            -5.7379,
            -2.3
          ]
        },
        {
          "name": "armillary",
          "min_xz": [
            -6.31,
            -4.41
          ],
          "max_xz": [
            -5.79,
            -3.89
          ]
        },
        {
          "name": "reading_table_0",
          "min_xz": [
            4.06,
            -3.85
          ],
          "max_xz": [
            5.94,
            -1.65
          ]
        },
        {
          "name": "reading_table_1",
          "min_xz": [
            4.06,
            1.65
          ],
          "max_xz": [
            5.94,
            3.85
          ]
        },
        {
          "name": "window_seat_L",
          "min_xz": [
            6.45,
            -3.88
          ],
          "max_xz": [
            7.0,
            -2.12
          ]
        },
        {
          "name": "window_seat_R",
          "min_xz": [
            6.45,
            2.12
          ],
          "max_xz": [
            7.0,
            3.88
          ]
        },
        {
          "name": "stair_dressing",
          "min_xz": [
            3.901,
            -0.715
          ],
          "max_xz": [
            6.9009,
            0.715
          ]
        }
      ],
      "holes": []
    }
  ],
  "ramps": [],
  "bays": [
    {
      "subject": 0,
      "index": 0,
      "pos": [
        -4.95,
        0.0,
        -5.295
      ],
      "rot": [
        0.707107,
        0.0,
        0.707107,
        0.0
      ]
    },
    {
      "subject": 0,
      "index": 1,
      "pos": [
        -4.05,
        0.0,
        -5.295
      ],
      "rot": [
        0.707107,
        0.0,
        0.707107,
        0.0
      ]
    },
    {
      "subject": 0,
      "index": 2,
      "pos": [
        -3.15,
        0.0,
        -5.295
      ],
      "rot": [
        0.707107,
        0.0,
        0.707107,
        0.0
      ]
    },
    {
      "subject": 1,
      "index": 0,
      "pos": [
        -2.25,
        0.0,
        -5.295
      ],
      "rot": [
        0.707107,
        0.0,
        0.707107,
        0.0
      ]
    },
    {
      "subject": 1,
      "index": 1,
      "pos": [
        -1.35,
        0.0,
        -5.295
      ],
      "rot": [
        0.707107,
        0.0,
        0.707107,
        0.0
      ]
    },
    {
      "subject": 1,
      "index": 2,
      "pos": [
        -0.45,
        0.0,
        -5.295
      ],
      "rot": [
        0.707107,
        0.0,
        0.707107,
        0.0
      ]
    },
    {
      "subject": 2,
      "index": 0,
      "pos": [
        0.45,
        0.0,
        -5.295
      ],
      "rot": [
        0.707107,
        0.0,
        0.707107,
        0.0
      ]
    },
    {
      "subject": 2,
      "index": 1,
      "pos": [
        1.35,
        0.0,
        -5.295
      ],
      "rot": [
        0.707107,
        0.0,
        0.707107,
        0.0
      ]
    },
    {
      "subject": 2,
      "index": 2,
      "pos": [
        2.25,
        0.0,
        -5.295
      ],
      "rot": [
        0.707107,
        0.0,
        0.707107,
        0.0
      ]
    },
    {
      "subject": 3,
      "index": 0,
      "pos": [
        3.15,
        0.0,
        -5.295
      ],
      "rot": [
        0.707107,
        0.0,
        0.707107,
        0.0
      ]
    },
    {
      "subject": 3,
      "index": 1,
      "pos": [
        4.05,
        0.0,
        -5.295
      ],
      "rot": [
        0.707107,
        0.0,
        0.707107,
        0.0
      ]
    },
    {
      "subject": 3,
      "index": 2,
      "pos": [
        4.95,
        0.0,
        -5.295
      ],
      "rot": [
        0.707107,
        0.0,
        0.707107,
        0.0
      ]
    },
    {
      "subject": 4,
      "index": 0,
      "pos": [
        -4.95,
        0.0,
        5.295
      ],
      "rot": [
        0.707107,
        0.0,
        -0.707107,
        0.0
      ]
    },
    {
      "subject": 4,
      "index": 1,
      "pos": [
        -4.05,
        0.0,
        5.295
      ],
      "rot": [
        0.707107,
        0.0,
        -0.707107,
        0.0
      ]
    },
    {
      "subject": 4,
      "index": 2,
      "pos": [
        -3.15,
        0.0,
        5.295
      ],
      "rot": [
        0.707107,
        0.0,
        -0.707107,
        0.0
      ]
    },
    {
      "subject": 5,
      "index": 0,
      "pos": [
        -2.25,
        0.0,
        5.295
      ],
      "rot": [
        0.707107,
        0.0,
        -0.707107,
        0.0
      ]
    },
    {
      "subject": 5,
      "index": 1,
      "pos": [
        -1.35,
        0.0,
        5.295
      ],
      "rot": [
        0.707107,
        0.0,
        -0.707107,
        0.0
      ]
    },
    {
      "subject": 5,
      "index": 2,
      "pos": [
        -0.45,
        0.0,
        5.295
      ],
      "rot": [
        0.707107,
        0.0,
        -0.707107,
        0.0
      ]
    },
    {
      "subject": 6,
      "index": 0,
      "pos": [
        0.45,
        0.0,
        5.295
      ],
      "rot": [
        0.707107,
        0.0,
        -0.707107,
        0.0
      ]
    },
    {
      "subject": 6,
      "index": 1,
      "pos": [
        1.35,
        0.0,
        5.295
      ],
      "rot": [
        0.707107,
        0.0,
        -0.707107,
        0.0
      ]
    },
    {
      "subject": 6,
      "index": 2,
      "pos": [
        2.25,
        0.0,
        5.295
      ],
      "rot": [
        0.707107,
        0.0,
        -0.707107,
        0.0
      ]
    },
    {
      "subject": 7,
      "index": 0,
      "pos": [
        3.15,
        0.0,
        5.295
      ],
      "rot": [
        0.707107,
        0.0,
        -0.707107,
        0.0
      ]
    },
    {
      "subject": 7,
      "index": 1,
      "pos": [
        4.05,
        0.0,
        5.295
      ],
      "rot": [
        0.707107,
        0.0,
        -0.707107,
        0.0
      ]
    },
    {
      "subject": 7,
      "index": 2,
      "pos": [
        4.95,
        0.0,
        5.295
      ],
      "rot": [
        0.707107,
        0.0,
        -0.707107,
        0.0
      ]
    }
  ],
  "slots_bay_local": [
    {
      "row": 0,
      "series": 0,
      "volume": 1,
      "pos": [
        0.09,
        0.1,
        -0.394
      ]
    },
    {
      "row": 0,
      "series": 0,
      "volume": 2,
      "pos": [
        0.09,
        0.1,
        -0.35
      ]
    },
    {
      "row": 0,
      "series": 0,
      "volume": 3,
      "pos": [
        0.09,
        0.1,
        -0.306
      ]
    },
    {
      "row": 0,
      "series": 1,
      "volume": 1,
      "pos": [
        0.09,
        0.1,
        -0.254
      ]
    },
    {
      "row": 0,
      "series": 1,
      "volume": 2,
      "pos": [
        0.09,
        0.1,
        -0.21
      ]
    },
    {
      "row": 0,
      "series": 1,
      "volume": 3,
      "pos": [
        0.09,
        0.1,
        -0.166
      ]
    },
    {
      "row": 0,
      "series": 2,
      "volume": 1,
      "pos": [
        0.09,
        0.1,
        -0.114
      ]
    },
    {
      "row": 0,
      "series": 2,
      "volume": 2,
      "pos": [
        0.09,
        0.1,
        -0.07
      ]
    },
    {
      "row": 0,
      "series": 2,
      "volume": 3,
      "pos": [
        0.09,
        0.1,
        -0.026
      ]
    },
    {
      "row": 0,
      "series": 3,
      "volume": 1,
      "pos": [
        0.09,
        0.1,
        0.026
      ]
    },
    {
      "row": 0,
      "series": 3,
      "volume": 2,
      "pos": [
        0.09,
        0.1,
        0.07
      ]
    },
    {
      "row": 0,
      "series": 3,
      "volume": 3,
      "pos": [
        0.09,
        0.1,
        0.114
      ]
    },
    {
      "row": 0,
      "series": 4,
      "volume": 1,
      "pos": [
        0.09,
        0.1,
        0.166
      ]
    },
    {
      "row": 0,
      "series": 4,
      "volume": 2,
      "pos": [
        0.09,
        0.1,
        0.21
      ]
    },
    {
      "row": 0,
      "series": 4,
      "volume": 3,
      "pos": [
        0.09,
        0.1,
        0.254
      ]
    },
    {
      "row": 0,
      "series": 5,
      "volume": 1,
      "pos": [
        0.09,
        0.1,
        0.306
      ]
    },
    {
      "row": 0,
      "series": 5,
      "volume": 2,
      "pos": [
        0.09,
        0.1,
        0.35
      ]
    },
    {
      "row": 0,
      "series": 5,
      "volume": 3,
      "pos": [
        0.09,
        0.1,
        0.394
      ]
    },
    {
      "row": 1,
      "series": 0,
      "volume": 1,
      "pos": [
        0.09,
        0.38,
        -0.394
      ]
    },
    {
      "row": 1,
      "series": 0,
      "volume": 2,
      "pos": [
        0.09,
        0.38,
        -0.35
      ]
    },
    {
      "row": 1,
      "series": 0,
      "volume": 3,
      "pos": [
        0.09,
        0.38,
        -0.306
      ]
    },
    {
      "row": 1,
      "series": 1,
      "volume": 1,
      "pos": [
        0.09,
        0.38,
        -0.254
      ]
    },
    {
      "row": 1,
      "series": 1,
      "volume": 2,
      "pos": [
        0.09,
        0.38,
        -0.21
      ]
    },
    {
      "row": 1,
      "series": 1,
      "volume": 3,
      "pos": [
        0.09,
        0.38,
        -0.166
      ]
    },
    {
      "row": 1,
      "series": 2,
      "volume": 1,
      "pos": [
        0.09,
        0.38,
        -0.114
      ]
    },
    {
      "row": 1,
      "series": 2,
      "volume": 2,
      "pos": [
        0.09,
        0.38,
        -0.07
      ]
    },
    {
      "row": 1,
      "series": 2,
      "volume": 3,
      "pos": [
        0.09,
        0.38,
        -0.026
      ]
    },
    {
      "row": 1,
      "series": 3,
      "volume": 1,
      "pos": [
        0.09,
        0.38,
        0.026
      ]
    },
    {
      "row": 1,
      "series": 3,
      "volume": 2,
      "pos": [
        0.09,
        0.38,
        0.07
      ]
    },
    {
      "row": 1,
      "series": 3,
      "volume": 3,
      "pos": [
        0.09,
        0.38,
        0.114
      ]
    },
    {
      "row": 1,
      "series": 4,
      "volume": 1,
      "pos": [
        0.09,
        0.38,
        0.166
      ]
    },
    {
      "row": 1,
      "series": 4,
      "volume": 2,
      "pos": [
        0.09,
        0.38,
        0.21
      ]
    },
    {
      "row": 1,
      "series": 4,
      "volume": 3,
      "pos": [
        0.09,
        0.38,
        0.254
      ]
    },
    {
      "row": 1,
      "series": 5,
      "volume": 1,
      "pos": [
        0.09,
        0.38,
        0.306
      ]
    },
    {
      "row": 1,
      "series": 5,
      "volume": 2,
      "pos": [
        0.09,
        0.38,
        0.35
      ]
    },
    {
      "row": 1,
      "series": 5,
      "volume": 3,
      "pos": [
        0.09,
        0.38,
        0.394
      ]
    },
    {
      "row": 2,
      "series": 0,
      "volume": 1,
      "pos": [
        0.09,
        0.66,
        -0.394
      ]
    },
    {
      "row": 2,
      "series": 0,
      "volume": 2,
      "pos": [
        0.09,
        0.66,
        -0.35
      ]
    },
    {
      "row": 2,
      "series": 0,
      "volume": 3,
      "pos": [
        0.09,
        0.66,
        -0.306
      ]
    },
    {
      "row": 2,
      "series": 1,
      "volume": 1,
      "pos": [
        0.09,
        0.66,
        -0.254
      ]
    },
    {
      "row": 2,
      "series": 1,
      "volume": 2,
      "pos": [
        0.09,
        0.66,
        -0.21
      ]
    },
    {
      "row": 2,
      "series": 1,
      "volume": 3,
      "pos": [
        0.09,
        0.66,
        -0.166
      ]
    },
    {
      "row": 2,
      "series": 2,
      "volume": 1,
      "pos": [
        0.09,
        0.66,
        -0.114
      ]
    },
    {
      "row": 2,
      "series": 2,
      "volume": 2,
      "pos": [
        0.09,
        0.66,
        -0.07
      ]
    },
    {
      "row": 2,
      "series": 2,
      "volume": 3,
      "pos": [
        0.09,
        0.66,
        -0.026
      ]
    },
    {
      "row": 2,
      "series": 3,
      "volume": 1,
      "pos": [
        0.09,
        0.66,
        0.026
      ]
    },
    {
      "row": 2,
      "series": 3,
      "volume": 2,
      "pos": [
        0.09,
        0.66,
        0.07
      ]
    },
    {
      "row": 2,
      "series": 3,
      "volume": 3,
      "pos": [
        0.09,
        0.66,
        0.114
      ]
    },
    {
      "row": 2,
      "series": 4,
      "volume": 1,
      "pos": [
        0.09,
        0.66,
        0.166
      ]
    },
    {
      "row": 2,
      "series": 4,
      "volume": 2,
      "pos": [
        0.09,
        0.66,
        0.21
      ]
    },
    {
      "row": 2,
      "series": 4,
      "volume": 3,
      "pos": [
        0.09,
        0.66,
        0.254
      ]
    },
    {
      "row": 2,
      "series": 5,
      "volume": 1,
      "pos": [
        0.09,
        0.66,
        0.306
      ]
    },
    {
      "row": 2,
      "series": 5,
      "volume": 2,
      "pos": [
        0.09,
        0.66,
        0.35
      ]
    },
    {
      "row": 2,
      "series": 5,
      "volume": 3,
      "pos": [
        0.09,
        0.66,
        0.394
      ]
    },
    {
      "row": 3,
      "series": 0,
      "volume": 1,
      "pos": [
        0.09,
        0.94,
        -0.394
      ]
    },
    {
      "row": 3,
      "series": 0,
      "volume": 2,
      "pos": [
        0.09,
        0.94,
        -0.35
      ]
    },
    {
      "row": 3,
      "series": 0,
      "volume": 3,
      "pos": [
        0.09,
        0.94,
        -0.306
      ]
    },
    {
      "row": 3,
      "series": 1,
      "volume": 1,
      "pos": [
        0.09,
        0.94,
        -0.254
      ]
    },
    {
      "row": 3,
      "series": 1,
      "volume": 2,
      "pos": [
        0.09,
        0.94,
        -0.21
      ]
    },
    {
      "row": 3,
      "series": 1,
      "volume": 3,
      "pos": [
        0.09,
        0.94,
        -0.166
      ]
    },
    {
      "row": 3,
      "series": 2,
      "volume": 1,
      "pos": [
        0.09,
        0.94,
        -0.114
      ]
    },
    {
      "row": 3,
      "series": 2,
      "volume": 2,
      "pos": [
        0.09,
        0.94,
        -0.07
      ]
    },
    {
      "row": 3,
      "series": 2,
      "volume": 3,
      "pos": [
        0.09,
        0.94,
        -0.026
      ]
    },
    {
      "row": 3,
      "series": 3,
      "volume": 1,
      "pos": [
        0.09,
        0.94,
        0.026
      ]
    },
    {
      "row": 3,
      "series": 3,
      "volume": 2,
      "pos": [
        0.09,
        0.94,
        0.07
      ]
    },
    {
      "row": 3,
      "series": 3,
      "volume": 3,
      "pos": [
        0.09,
        0.94,
        0.114
      ]
    },
    {
      "row": 3,
      "series": 4,
      "volume": 1,
      "pos": [
        0.09,
        0.94,
        0.166
      ]
    },
    {
      "row": 3,
      "series": 4,
      "volume": 2,
      "pos": [
        0.09,
        0.94,
        0.21
      ]
    },
    {
      "row": 3,
      "series": 4,
      "volume": 3,
      "pos": [
        0.09,
        0.94,
        0.254
      ]
    },
    {
      "row": 3,
      "series": 5,
      "volume": 1,
      "pos": [
        0.09,
        0.94,
        0.306
      ]
    },
    {
      "row": 3,
      "series": 5,
      "volume": 2,
      "pos": [
        0.09,
        0.94,
        0.35
      ]
    },
    {
      "row": 3,
      "series": 5,
      "volume": 3,
      "pos": [
        0.09,
        0.94,
        0.394
      ]
    },
    {
      "row": 4,
      "series": 0,
      "volume": 1,
      "pos": [
        0.09,
        1.22,
        -0.394
      ]
    },
    {
      "row": 4,
      "series": 0,
      "volume": 2,
      "pos": [
        0.09,
        1.22,
        -0.35
      ]
    },
    {
      "row": 4,
      "series": 0,
      "volume": 3,
      "pos": [
        0.09,
        1.22,
        -0.306
      ]
    },
    {
      "row": 4,
      "series": 1,
      "volume": 1,
      "pos": [
        0.09,
        1.22,
        -0.254
      ]
    },
    {
      "row": 4,
      "series": 1,
      "volume": 2,
      "pos": [
        0.09,
        1.22,
        -0.21
      ]
    },
    {
      "row": 4,
      "series": 1,
      "volume": 3,
      "pos": [
        0.09,
        1.22,
        -0.166
      ]
    },
    {
      "row": 4,
      "series": 2,
      "volume": 1,
      "pos": [
        0.09,
        1.22,
        -0.114
      ]
    },
    {
      "row": 4,
      "series": 2,
      "volume": 2,
      "pos": [
        0.09,
        1.22,
        -0.07
      ]
    },
    {
      "row": 4,
      "series": 2,
      "volume": 3,
      "pos": [
        0.09,
        1.22,
        -0.026
      ]
    },
    {
      "row": 4,
      "series": 3,
      "volume": 1,
      "pos": [
        0.09,
        1.22,
        0.026
      ]
    },
    {
      "row": 4,
      "series": 3,
      "volume": 2,
      "pos": [
        0.09,
        1.22,
        0.07
      ]
    },
    {
      "row": 4,
      "series": 3,
      "volume": 3,
      "pos": [
        0.09,
        1.22,
        0.114
      ]
    },
    {
      "row": 4,
      "series": 4,
      "volume": 1,
      "pos": [
        0.09,
        1.22,
        0.166
      ]
    },
    {
      "row": 4,
      "series": 4,
      "volume": 2,
      "pos": [
        0.09,
        1.22,
        0.21
      ]
    },
    {
      "row": 4,
      "series": 4,
      "volume": 3,
      "pos": [
        0.09,
        1.22,
        0.254
      ]
    },
    {
      "row": 4,
      "series": 5,
      "volume": 1,
      "pos": [
        0.09,
        1.22,
        0.306
      ]
    },
    {
      "row": 4,
      "series": 5,
      "volume": 2,
      "pos": [
        0.09,
        1.22,
        0.35
      ]
    },
    {
      "row": 4,
      "series": 5,
      "volume": 3,
      "pos": [
        0.09,
        1.22,
        0.394
      ]
    },
    {
      "row": 5,
      "series": 0,
      "volume": 1,
      "pos": [
        0.09,
        1.5,
        -0.394
      ]
    },
    {
      "row": 5,
      "series": 0,
      "volume": 2,
      "pos": [
        0.09,
        1.5,
        -0.35
      ]
    },
    {
      "row": 5,
      "series": 0,
      "volume": 3,
      "pos": [
        0.09,
        1.5,
        -0.306
      ]
    },
    {
      "row": 5,
      "series": 1,
      "volume": 1,
      "pos": [
        0.09,
        1.5,
        -0.254
      ]
    },
    {
      "row": 5,
      "series": 1,
      "volume": 2,
      "pos": [
        0.09,
        1.5,
        -0.21
      ]
    },
    {
      "row": 5,
      "series": 1,
      "volume": 3,
      "pos": [
        0.09,
        1.5,
        -0.166
      ]
    },
    {
      "row": 5,
      "series": 2,
      "volume": 1,
      "pos": [
        0.09,
        1.5,
        -0.114
      ]
    },
    {
      "row": 5,
      "series": 2,
      "volume": 2,
      "pos": [
        0.09,
        1.5,
        -0.07
      ]
    },
    {
      "row": 5,
      "series": 2,
      "volume": 3,
      "pos": [
        0.09,
        1.5,
        -0.026
      ]
    },
    {
      "row": 5,
      "series": 3,
      "volume": 1,
      "pos": [
        0.09,
        1.5,
        0.026
      ]
    },
    {
      "row": 5,
      "series": 3,
      "volume": 2,
      "pos": [
        0.09,
        1.5,
        0.07
      ]
    },
    {
      "row": 5,
      "series": 3,
      "volume": 3,
      "pos": [
        0.09,
        1.5,
        0.114
      ]
    },
    {
      "row": 5,
      "series": 4,
      "volume": 1,
      "pos": [
        0.09,
        1.5,
        0.166
      ]
    },
    {
      "row": 5,
      "series": 4,
      "volume": 2,
      "pos": [
        0.09,
        1.5,
        0.21
      ]
    },
    {
      "row": 5,
      "series": 4,
      "volume": 3,
      "pos": [
        0.09,
        1.5,
        0.254
      ]
    },
    {
      "row": 5,
      "series": 5,
      "volume": 1,
      "pos": [
        0.09,
        1.5,
        0.306
      ]
    },
    {
      "row": 5,
      "series": 5,
      "volume": 2,
      "pos": [
        0.09,
        1.5,
        0.35
      ]
    },
    {
      "row": 5,
      "series": 5,
      "volume": 3,
      "pos": [
        0.09,
        1.5,
        0.394
      ]
    },
    {
      "row": 6,
      "series": 0,
      "volume": 1,
      "pos": [
        0.09,
        1.78,
        -0.394
      ]
    },
    {
      "row": 6,
      "series": 0,
      "volume": 2,
      "pos": [
        0.09,
        1.78,
        -0.35
      ]
    },
    {
      "row": 6,
      "series": 0,
      "volume": 3,
      "pos": [
        0.09,
        1.78,
        -0.306
      ]
    },
    {
      "row": 6,
      "series": 1,
      "volume": 1,
      "pos": [
        0.09,
        1.78,
        -0.254
      ]
    },
    {
      "row": 6,
      "series": 1,
      "volume": 2,
      "pos": [
        0.09,
        1.78,
        -0.21
      ]
    },
    {
      "row": 6,
      "series": 1,
      "volume": 3,
      "pos": [
        0.09,
        1.78,
        -0.166
      ]
    },
    {
      "row": 6,
      "series": 2,
      "volume": 1,
      "pos": [
        0.09,
        1.78,
        -0.114
      ]
    },
    {
      "row": 6,
      "series": 2,
      "volume": 2,
      "pos": [
        0.09,
        1.78,
        -0.07
      ]
    },
    {
      "row": 6,
      "series": 2,
      "volume": 3,
      "pos": [
        0.09,
        1.78,
        -0.026
      ]
    },
    {
      "row": 6,
      "series": 3,
      "volume": 1,
      "pos": [
        0.09,
        1.78,
        0.026
      ]
    },
    {
      "row": 6,
      "series": 3,
      "volume": 2,
      "pos": [
        0.09,
        1.78,
        0.07
      ]
    },
    {
      "row": 6,
      "series": 3,
      "volume": 3,
      "pos": [
        0.09,
        1.78,
        0.114
      ]
    },
    {
      "row": 6,
      "series": 4,
      "volume": 1,
      "pos": [
        0.09,
        1.78,
        0.166
      ]
    },
    {
      "row": 6,
      "series": 4,
      "volume": 2,
      "pos": [
        0.09,
        1.78,
        0.21
      ]
    },
    {
      "row": 6,
      "series": 4,
      "volume": 3,
      "pos": [
        0.09,
        1.78,
        0.254
      ]
    },
    {
      "row": 6,
      "series": 5,
      "volume": 1,
      "pos": [
        0.09,
        1.78,
        0.306
      ]
    },
    {
      "row": 6,
      "series": 5,
      "volume": 2,
      "pos": [
        0.09,
        1.78,
        0.35
      ]
    },
    {
      "row": 6,
      "series": 5,
      "volume": 3,
      "pos": [
        0.09,
        1.78,
        0.394
      ]
    }
  ]
} as const;
