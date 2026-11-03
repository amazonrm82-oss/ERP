// LIB-01: the categories a new business starts with (managed list: renamed or deleted freely). Mirrors
// app.seed_library_categories() in migration content_library (unit test library).
export const DEFAULT_LIBRARY_CATEGORIES = ["קטלוגים", "מחירונים", "מצגות", "סרטונים", "מסמכים כלליים"] as const;

export const MAX_LIBRARY_CATEGORIES = 50;
export const MAX_LIBRARY_ITEMS = 1000;
