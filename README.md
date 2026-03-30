# MLB DFS Local Tool
checking in firt commit

A local website for uploading, managing, and analyzing MLB Daily Fantasy Sports (DFS) files. Built with Node.js/Express backend and a modern responsive frontend.

## Features

✨ **File Upload**
- Drag-and-drop CSV file uploads
- Support for multiple files at once
- Automatic file detection and validation

📁 **File Management**
- View uploaded files with details (size, upload date)
- Delete files you no longer need
- Download files anytime

👀 **File Viewer**
- Preview CSV files in a formatted table
- View first 50 rows of data
- Copy preview to clipboard

📊 **Analytics**
- File statistics dashboard
- Total files, sizes, and types

## Quick Start

### 1. Install Dependencies

```bash
cd c:\Users\cjevi\projects\mlb-dfs-local
npm install
```

### 2. Start the Server

```bash
npm start
```

You'll see:
```
🚀 MLB DFS Local Tool running on http://localhost:3000
📁 Uploads directory: c:\Users\cjevi\projects\mlb-dfs-local\uploads
```

### 3. Open in Browser

Navigate to: **http://localhost:3000**

## File Organization

```
mlb-dfs-local/
├── server.js           # Express server with file upload API
├── package.json        # Dependencies
├── public/
│   └── index.html      # Frontend interface
└── uploads/            # Stored uploaded files (auto-created)
```

## Supported File Types

- **DraftKings Salaries** (`DKSalaries.csv`)
- **ROO Exports** (`MLB_ROO_export.csv`)
- **Stack Files** (`*_3man*.csv`, `*_5man*.csv`)
- **Any CSV file** (CSV format support)

## Usage

### Upload Files
1. Click the dropzone or drag files
2. Select one or more CSV files
3. Files are instantly uploaded and processed

### View Files
1. Go to "File Viewer" tab
2. Select a file from the dropdown
3. See preview with first 50 rows
4. Download or copy to clipboard

### Delete Files
1. Click "Delete" button on any file
2. Confirm deletion
3. File removed from server

## API Endpoints

### POST `/api/upload`
Upload multiple CSV files
```javascript
const formData = new FormData();
formData.append('files', file1);
formData.append('files', file2);
fetch('/api/upload', { method: 'POST', body: formData });
```

### GET `/api/files`
List all uploaded files with metadata

### GET `/api/files/:filename/content`
Get file content as text

### GET `/api/files/:filename/download`
Download file

### DELETE `/api/files/:filename`
Delete a file

## Features Overview

### Upload & Manage Tab
- Drag-and-drop interface
- File list with metadata
- Quick actions (View, Download, Delete)
- Upload statistics dashboard

### File Viewer Tab
- dropdown selector
- Formatted CSV preview
- Copy to clipboard
- Download option

### Analyze Tab
- File statistics
- Summary metrics
- Data insights

## Keyboard Shortcuts

- `Ctrl+Click` - Select multiple files (when uploading)
- `Escape` - Close alerts

## Performance

- Handles multiple large CSV files efficiently
- Preview limited to 50 rows for performance
- Streaming uploads support
- Real-time file synchronization

## Storage

Files are stored in the `uploads/` directory in the project root. You can:
- Access files via the web interface
- Delete through the app
- Manually delete from filesystem

## Troubleshooting

### Port 3000 already in use?
Change the port in `server.js`:
```javascript
const PORT = 3001; // Change to another port
```

### Files not uploading?
- Check file is CSV format
- Verify file size (max 10 files at once)
- Check browser console for errors

### Preview not showing?
- Ensure CSV has headers
- Check file is valid CSV format

## Future Enhancements

- CSV data analysis and filtering
- Player pool visualization
- Lineup builder integration
- Export to DraftKings format
- Dark mode toggle
- Mobile optimization

## License

Personal project for DFS analysis

## Support

For issues, check:
1. Browser console (F12)
2. Server console output
3. Verify CSV file format
4. Check file permissions
