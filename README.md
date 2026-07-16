# ⚡ AI Framework Migration Studio

An AI-powered framework migration and refactoring pipeline that seamlessly converts Angular and React projects using OpenAI-compatible APIs.

![Angular](https://img.shields.io/badge/Angular-20.x-DD0031?style=flat&logo=angular&logoColor=white)
![React](https://img.shields.io/badge/React-18.x-61DAFB?style=flat&logo=react&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat&logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue.svg)


## 🎯 Overview

AI Framework Migration Studio is a full-stack application that uses artificial intelligence to automate the migration of frontend projects between Angular and React frameworks. Upload your source code as a ZIP file, describe your migration requirements, and let the AI engine generate a complete, working project in your target framework.

### Key Capabilities

- **Framework Conversion**: Seamlessly convert between Angular and React projects
- **AI-Powered Analysis**: Uses OpenAI-compatible APIs for intelligent code transformation
- **Automated Setup**: Generates complete project configurations (package.json, tsconfig, etc.)
- **Smart Validation**: Validates uploaded projects against expected framework signatures
- **Drag & Drop Upload**: Intuitive file upload with progress feedback

## ✨ Features

### Frontend (Angular 20)
- Modern standalone component architecture
- Signals-based state management
- Responsive design with mobile-first approach
- Drag & drop file upload with validation
- Real-time migration status updates

### Backend (Node.js/Express)
- RESTful API with Express.js (ES Modules)
- OpenAI-compatible API integration
- ZIP file extraction and validation
- Temporary file cleanup
- Rate limiting for AI API calls

### AI Migration Engine
- Multi-stage migration pipeline
- Blueprint generation for migration planning
- File-by-file code generation
- Automatic project scaffolding
- Support for multiple target frameworks

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend (Angular)                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │   App      │  │   Upload    │  │   Status    │             │
│  │   Component│  │   Service   │  │   Display   │             │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         │                │                │                     │
│         └────────────────┼────────────────┘                     │
│                          │ HTTP POST                            │
└──────────────────────────┼──────────────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────────────┐
│                    Backend (Express)                              │
│  ┌──────────────────────┴──────────────────────┐                │
│  │              Upload Middleware                │                │
│  │           (Multer + Validation)               │                │
│  └──────────────────────┬──────────────────────┘                │
│                          │                                       │
│  ┌──────────────────────┴──────────────────────┐                │
│  │            Migration Pipeline                │                │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐    │                │
│  │  │Extract  │→ │Blueprint│→ │Generate │    │                │
│  │  │ZIP      │  │Agent    │  │Files    │    │                │
│  │  └─────────┘  └─────────┘  └─────────┘    │                │
│  └──────────────────────┬──────────────────────┘                │
│                          │                                       │
│  ┌──────────────────────┴──────────────────────┐                │
│  │         OpenAI-Compatible API                 │                │
│  │        (zenmux.ai / OpenAI / etc.)            │                │
│  └─────────────────────────────────────────────┘                │
└──────────────────────────────────────────────────────────────────┘
```

## 📦 Prerequisites

- **Node.js**: v18.0.0 or higher
- **npm**: v9.0.0 or higher
- **Angular CLI**: v20.x (for frontend development)
- **OpenAI API Key**: Or any OpenAI-compatible API endpoint

## 🚀 Installation

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/ai-architecture-migrator.git
cd ai-architecture-migrator
```

### 2. Install Dependencies

```bash
# Install all dependencies (root, frontend, server)
npm run install:all
```

Or install manually:

```bash
# Root dependencies
npm install

# Frontend dependencies
cd frontend && npm install && cd ..

# Server dependencies
cd server && npm install && cd ..
```

### 3. Configure Environment Variables

Create a `.env` file in the `server/` directory:

```bash
cd server
cp .env.example .env  # if .env.example exists, or create manually
```

Edit `server/.env`:

```env
# Server Configuration
PORT=5000

# OpenAI API Configuration
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4

# Optional: Custom API endpoint (e.g., for free alternatives)
# OPENAI_BASE_URL=https://zenmux.ai/api/v1
# OPENAI_MODEL=stepfun/step-3.7-flash-free
```

### 4. Start the Application

```bash
# Start both frontend and backend
npm start
```

Or start individually:

```bash
# Start backend only (http://localhost:5000)
npm run start:backend

# Start frontend only (http://localhost:4200)
npm run start:frontend
```

## ⚙️ Configuration

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PORT` | Backend server port | `5000` | No |
| `OPENAI_API_KEY` | API key for OpenAI-compatible service | - | Yes |
| `OPENAI_BASE_URL` | API endpoint URL | `https://zenmux.ai/api/v1` | No |
| `OPENAI_MODEL` | Model to use for migration | `stepfun/step-3.7-flash-free` | No |

### Supported API Providers

The application uses the OpenAI SDK, so any OpenAI-compatible API works:

- **OpenAI**: `https://api.openai.com/v1`
- **Anthropic**: Via OpenAI-compatible proxy (e.g., LiteLLM)
- **Local Models**: Ollama, LM Studio, vLLM, etc.
- **Free Alternatives**: zenmux.ai, groq.com, together.ai, etc.

### File Limits

- **Maximum Upload Size**: 50 MB
- **Supported Archive Format**: .zip only
- **Recognized Text Files**: .ts, .tsx, .js, .jsx, .html, .css, .scss, .json, .md, .yaml, .yml

## 📖 Usage

### Web Interface

1. **Open the Application**
   - Navigate to `http://localhost:4200`

2. **Select Migration Path**
   - Choose source framework (Angular or React)
   - Choose target framework (Angular or React)

3. **Describe Migration Requirements**
   - Enter detailed instructions for the AI
   - Example: "Convert all components to use functional components with hooks"

4. **Upload Source Code**
   - Drag and drop your project ZIP file
   - Or click to browse and select the file

5. **Start Migration**
   - Click "Initialize AI Pipeline"
   - Wait for the AI to process your project
   - Download the converted project ZIP

### Command Line (API)

```bash
# Upload and migrate a project
curl -X POST http://localhost:5000/api/migrate \
  -F "zipFile=@/path/to/your/project.zip" \
  -F "prompt=Convert Angular components to React functional components" \
  -F "fromTech=Angular" \
  -F "toTech=React" \
  -o migrated_project.zip
```

### Example Migration Prompts

**Angular to React:**
```
Convert this Angular project to React:
- Transform all components to functional components with hooks
- Use React Router for navigation
- Replace Angular services with React Context or custom hooks
- Maintain all existing functionality and styling
- Add proper TypeScript types
```

**React to Angular:**
```
Convert this React project to Angular:
- Transform functional components to Angular standalone components
- Use Angular Router for navigation
- Replace React hooks with Angular services and signals
- Use Angular forms for form handling
- Maintain all existing functionality and styling
```

**Tips for Better Results:**
- Be specific about what you want converted
- Mention any frameworks/libraries to preserve (e.g., styling libraries)
- Specify if you want to keep the same directory structure
- Note any specific patterns you want the AI to follow

## 🛠️ Development

### Running in Development Mode

```bash
# Start with hot reload
npm start

# Or start backend with file watching
cd server && npm run dev
```

### Adding New Features

1. **Frontend Components**
   - Create standalone components in `frontend/src/app/`
   - Use Angular Signals for state management
   - Follow the existing component structure

2. **Backend Routes**
   - Add routes in `server/src/routes/`
   - Use middleware for validation
   - Handle errors gracefully

3. **AI Prompts**
   - Modify prompts in `server/src/services/migration.js`
   - Test with different project types
   - Optimize for better code generation

### ES Modules

The server uses ES Modules (`"type": "module"` in package.json):
- Use `import/export` syntax
- Use `fileURLToPath` for `__filename` and `__dirname`
- Use `.js` extension in relative imports

## ⚠️ Known Limitations

1. **File Size**: Projects larger than 50MB cannot be uploaded
2. **AI Accuracy**: Generated code may require manual adjustments
3. **Complex Projects**: Very large or complex projects may hit API token limits
4. **Custom Libraries**: Third-party library usage may not be perfectly preserved
5. **Styling**: CSS/SCSS may need manual tweaking for exact visual parity
6. **API Costs**: Migration consumes API credits (cost depends on project size)
7. **Rate Limits**: Free API tiers may have strict rate limits
8. **Binary Files**: Images and other binary assets are not processed by AI

## 🔧 Troubleshooting

### Common Issues

#### "OPENAI_API_KEY is not set"
```bash
# Create or update server/.env
echo "OPENAI_API_KEY=your_key_here" > server/.env
```

#### "Port already in use"
```bash
# Change port in server/.env
echo "PORT=3001" >> server/.env
```

#### "No readable source files found"
- Ensure your ZIP contains actual source code
- Check that files aren't in a nested folder
- Verify file extensions are recognized (.ts, .tsx, .js, .jsx, etc.)

#### Migration fails midway
- Check API rate limits
- Reduce project size (exclude node_modules, dist, etc.)
- Verify API key has sufficient credits
- Try a simpler prompt

#### Generated project won't compile
- Some manual adjustments may be needed
- Check the generated package.json for correct dependencies
- Ensure all imports are correct


## 🙏 Acknowledgments

- [Angular](https://angular.io/) - Frontend framework
- [React](https://react.dev/) - UI library
- [Express](https://expressjs.com/) - Backend framework
- [OpenAI](https://openai.com/) - AI API specification
- [AdmZip](https://github.com/cthackers/adm-zip) - ZIP file handling
- [Multer](https://github.com/expressjs/multer) - File upload middleware


---

**Built with ❤️ by Team CodeMorph, for developers.**
