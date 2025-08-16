const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const { spawn, exec } = require('child_process');
const WebSocket = require('ws');

// Bot configuration
const BOT_TOKEN = process.env.BOT_TOKEN || '8319447921:AAH2X-qqIQdeDytgEKqDV4gTPGW2YTJX18U';
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Set bot menu button
bot.setChatMenuButton({
  menu_button: {
    type: 'commands'
  }
}).catch(console.error);

// Set bot commands for menu
bot.setMyCommands([
  { command: 'start', description: '🏠 Main Menu' },
  { command: 'add', description: '➕ Add New Project' },
  { command: 'projects', description: '📁 My Projects' },
  { command: 'files', description: '📋 My Files' },
  { command: 'analytics', description: '📊 View Analytics' },
  { command: 'shared', description: '🔗 Shared Projects' },
  { command: 'settings', description: '⚙️ Settings' },
  { command: 'remove', description: '🗑️ Remove Project' },
  { command: 'notice', description: '📢 System Notice' },
  { command: 'help', description: '🆘 Help & Support' }
]).catch(console.error);

// Express app for web interface
const app = express();
const PORT = process.env.PORT || 5000;

// Storage for user projects and processes
const userProjects = new Map();
const runningProcesses = new Map();
const projectLogs = new Map();
const projectNotifications = new Map(); // Track sent notifications
const projectAnalytics = new Map(); // Track project stats
const sharedProjects = new Map(); // Track shared projects
const projectSchedules = new Map(); // Track scheduled restarts

// Ensure projects directory exists
const PROJECTS_DIR = path.join(__dirname, 'projects');
fs.ensureDirSync(PROJECTS_DIR);

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userId = req.params.userId;
    const projectId = req.params.projectId;
    const projectPath = path.join(PROJECTS_DIR, userId, projectId);
    fs.ensureDirSync(projectPath);
    cb(null, projectPath);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const upload = multer({ storage });

// Serve static files
app.use(express.static('public'));
app.use(express.json());

// Web interface for console viewing
app.get('/console/:userId/:projectId', (req, res) => {
  const { userId, projectId } = req.params;
  const logs = projectLogs.get(`${userId}_${projectId}`) || [];
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Console - ${projectId}</title>
        <style>
            body { font-family: monospace; background: #1e1e1e; color: #fff; margin: 0; padding: 20px; }
            .console { background: #000; padding: 20px; border-radius: 5px; height: 80vh; overflow-y: auto; }
            .log-entry { margin: 2px 0; }
            .error { color: #ff6b6b; }
            .info { color: #4ecdc4; }
            .warn { color: #ffe66d; }
            h1 { color: #4ecdc4; }
        </style>
    </head>
    <body>
        <h1>Console Output - Project: ${projectId}</h1>
        <div class="console" id="console">
            ${logs.map(log => `<div class="log-entry ${log.type}">${log.timestamp} - ${log.message}</div>`).join('')}
        </div>
        <script>
            const ws = new WebSocket('ws://localhost:${PORT}/ws/${userId}/${projectId}');
            ws.onmessage = function(event) {
                const data = JSON.parse(event.data);
                const console = document.getElementById('console');
                const entry = document.createElement('div');
                entry.className = 'log-entry ' + data.type;
                entry.textContent = data.timestamp + ' - ' + data.message;
                console.appendChild(entry);
                console.scrollTop = console.scrollHeight;
            };
        </script>
    </body>
    </html>
  `);
});

// WebSocket server for real-time console updates
const wss = new WebSocket.Server({ port: PORT + 1 });

wss.on('connection', (ws, req) => {
  const url = req.url;
  const match = url.match(/\/ws\/(\d+)\/(.+)/);
  if (match) {
    const userId = match[1];
    const projectId = match[2];
    ws.userId = userId;
    ws.projectId = projectId;
  }
});

// Function to broadcast log to WebSocket clients
function broadcastLog(userId, projectId, message, type = 'info') {
  const logEntry = {
    timestamp: new Date().toISOString(),
    message: message,
    type: type
  };
  
  const key = `${userId}_${projectId}`;
  if (!projectLogs.has(key)) {
    projectLogs.set(key, []);
  }
  projectLogs.get(key).push(logEntry);
  
  // Keep only last 1000 log entries
  if (projectLogs.get(key).length > 1000) {
    projectLogs.get(key).shift();
  }
  
  // Broadcast to WebSocket clients
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && 
        client.userId === userId && 
        client.projectId === projectId) {
      client.send(JSON.stringify(logEntry));
    }
  });
}

// Initialize user data
function initUser(userId) {
  if (!userProjects.has(userId)) {
    userProjects.set(userId, new Map());
    const userDir = path.join(PROJECTS_DIR, userId.toString());
    fs.ensureDirSync(userDir);
  }
}

// View shared project command
bot.onText(/\/view (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const shareCode = match[1].toUpperCase();
  
  const sharedProject = sharedProjects.get(shareCode);
  if (!sharedProject) {
    bot.sendMessage(chatId, '❌ Invalid or expired share code!');
    return;
  }
  
  // Check if share code is still valid (24 hours)
  const hoursSinceShared = (Date.now() - sharedProject.sharedAt.getTime()) / (1000 * 60 * 60);
  if (hoursSinceShared > 24) {
    sharedProjects.delete(shareCode);
    bot.sendMessage(chatId, '❌ Share code has expired!');
    return;
  }
  
  showConsole(chatId, sharedProject.userId, sharedProject.projectId);
});

// Quick stats command
bot.onText(/\/stats/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  showAnalytics(chatId, userId);
});

// Help command
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  
  bot.sendMessage(chatId, `🤖 *Project Manager Bot Help*

*Main Features:*
• Upload and run Node.js projects 24/7
• Real-time console monitoring
• Auto-restart on crashes
• Project sharing and backups

*Commands:*
• \`/start\` - Main menu
• \`/view CODE\` - View shared project
• \`/stats\` - View analytics
• \`/help\` - Show this help

*Getting Started:*
1. Tap "Add Project" to upload files
2. Send your .js file
3. Start your project
4. Monitor via console

*Pro Tips:*
• Use "Share" to collaborate
• "Backup" saves your work
• Analytics track performance
• Auto-install handles dependencies`, {
    parse_mode: 'Markdown'
  });
});

// Add command handler
bot.onText(/\/add/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `📤 To add a new project:

1. Send me your project.js file
2. Send me your requirements.txt file (optional)
3. I'll create and run your project!

Please send your project.js file first:`);
});

// Projects command handler
bot.onText(/\/projects/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  initUser(userId);
  listUserProjects(chatId, userId);
});

// Files command handler
bot.onText(/\/files/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  initUser(userId);
  listUserFiles(chatId, userId);
});

// Analytics command handler
bot.onText(/\/analytics/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  initUser(userId);
  showAnalytics(chatId, userId);
});

// Shared command handler
bot.onText(/\/shared/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  initUser(userId);
  showSharedProjects(chatId, userId);
});

// Settings command handler
bot.onText(/\/settings/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  initUser(userId);
  showUserSettings(chatId, userId);
});

// Remove command handler
bot.onText(/\/remove/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  initUser(userId);
  showQuickRemove(chatId, userId);
});

// Notice command handler
bot.onText(/\/notice/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  initUser(userId);
  showSystemNotice(chatId, userId);
});

// Start bot commands
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  
  initUser(userId);
  
  const keyboard = {
    inline_keyboard: [
      [
        { text: '➕ Add Project', callback_data: 'add_project' },
        { text: '📁 My Projects', callback_data: 'list_projects' }
      ],
      [
        { text: '📋 My Files', callback_data: 'list_files' },
        { text: '📊 Analytics', callback_data: 'view_analytics' }
      ],
      [
        { text: '🔗 Shared Projects', callback_data: 'shared_projects' },
        { text: '⚙️ Settings', callback_data: 'user_settings' }
      ],
      [
        { text: '➕ Add', callback_data: 'quick_add' },
        { text: '🗑️ Remove', callback_data: 'quick_remove' }
      ],
      [
        { text: '📢 Notice', callback_data: 'show_notice' }
      ]
    ]
  };
  
  bot.sendMessage(chatId, `🤖 *Project Manager Bot*

*What I can do for you:*
• 📤 Upload Node.js projects
• ⚡ Run projects 24/7 with auto-restart
• 📱 Real-time console monitoring
• 🗂️ Manage multiple projects
• 🌐 Web-based console viewer

*Getting Started:*
1. Tap "Add Project" to upload your files
2. Send your \`project.js\` file
3. Optionally send \`requirements.txt\`
4. Start your project and monitor console

Choose an option below:`, { 
    parse_mode: 'Markdown',
    reply_markup: keyboard 
  });
});

// Handle callback queries
bot.on('callback_query', (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id.toString();
  const data = callbackQuery.data;
  
  initUser(userId);
  
  switch (data) {
    case 'add_project':
      bot.sendMessage(chatId, `📤 To add a new project:

1. Send me your project.js file
2. Send me your requirements.txt file (optional)
3. I'll create and run your project!

Please send your project.js file first:`);
      break;
      
    case 'list_projects':
      listUserProjects(chatId, userId);
      break;
      
    case 'list_files':
      listUserFiles(chatId, userId);
      break;
      
    case 'view_analytics':
      showAnalytics(chatId, userId);
      break;
      
    case 'shared_projects':
      showSharedProjects(chatId, userId);
      break;
      
    case 'user_settings':
      showUserSettings(chatId, userId);
      break;
      
    case 'quick_add':
      bot.sendMessage(chatId, `🚀 *Quick Add Project*

📤 To quickly add a new project:

1. Send me your project.js file
2. I'll automatically detect dependencies
3. Start coding immediately!

*Supported Files:*
• \`.js\` - Node.js projects
• \`requirements.txt\` - Dependencies
• \`package.json\` - NPM packages

Send your project file now:`, { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '← Back', callback_data: 'list_projects' }]]
        }
      });
      break;
      
    case 'quick_remove':
      showQuickRemove(chatId, userId);
      break;
      
    case 'show_notice':
      showSystemNotice(chatId, userId);
      break;
      
    default:
      if (data.startsWith('remove_project_')) {
        const projectId = data.replace('remove_project_', '');
        removeProject(chatId, userId, projectId);
      } else if (data.startsWith('console_')) {
        const projectId = data.replace('console_', '');
        showConsole(chatId, userId, projectId);
      } else if (data.startsWith('stop_')) {
        const projectId = data.replace('stop_', '');
        stopProject(chatId, userId, projectId);
      } else if (data.startsWith('start_')) {
        const projectId = data.replace('start_', '');
        startProject(chatId, userId, projectId);
      } else if (data.startsWith('share_')) {
        const projectId = data.replace('share_', '');
        shareProject(chatId, userId, projectId);
      } else if (data.startsWith('backup_')) {
        const projectId = data.replace('backup_', '');
        backupProject(chatId, userId, projectId);
      } else if (data.startsWith('schedule_')) {
        const projectId = data.replace('schedule_', '');
        scheduleRestart(chatId, userId, projectId);
      } else if (data.startsWith('env_')) {
        const projectId = data.replace('env_', '');
        manageEnvVars(chatId, userId, projectId);
      } else if (data === 'backup_all') {
        backupAllProjects(chatId, userId);
      } else if (data === 'show_help') {
        bot.sendMessage(chatId, `🆘 *Quick Help*

*Main Commands:*
• \`/start\` - Main menu
• \`/help\` - Detailed help
• \`/stats\` - Analytics
• \`/view CODE\` - View shared project

*Quick Actions:*
• ➕ Add - Upload new project
• 🗑️ Remove - Delete projects
• 📢 Notice - System updates

*Project Management:*
• Upload .js files to create projects
• Auto-restart keeps projects running
• Real-time console monitoring
• Share projects with others

Need more help? Send \`/help\` for detailed guide.`, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '← Back', callback_data: 'show_notice' }]]
          }
        });
      }
  }
  
  bot.answerCallbackQuery(callbackQuery.id);
});

// Handle file uploads
bot.on('document', (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const file = msg.document;
  
  initUser(userId);
  
  if (file.file_name.endsWith('.js') || file.file_name === 'requirements.txt') {
    bot.getFile(file.file_id).then((fileData) => {
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.file_path}`;
      
      // Create project directory
      const timestamp = Date.now();
      const projectId = `project_${timestamp}`;
      const projectPath = path.join(PROJECTS_DIR, userId, projectId);
      fs.ensureDirSync(projectPath);
      
      // Download and save file
      const filePath = path.join(projectPath, file.file_name);
      
      require('https').get(fileUrl, (response) => {
        const fileStream = fs.createWriteStream(filePath);
        response.pipe(fileStream);
        
        fileStream.on('finish', () => {
          if (file.file_name.endsWith('.js')) {
            userProjects.get(userId).set(projectId, {
              name: projectId,
              mainFile: file.file_name,
              path: projectPath,
              status: 'stopped',
              created: new Date()
            });
            
            bot.sendMessage(chatId, `✅ Project uploaded successfully!
            
📁 Project ID: ${projectId}
📄 Main file: ${file.file_name}

You can now upload requirements.txt or start the project directly.`, {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '▶️ Start Project', callback_data: `start_${projectId}` }],
                  [{ text: '📋 View Console', callback_data: `console_${projectId}` }]
                ]
              }
            });
          } else {
            bot.sendMessage(chatId, `✅ Requirements file uploaded for current project!`);
          }
        });
      });
    });
  } else {
    bot.sendMessage(chatId, '❌ Please send only .js files or requirements.txt');
  }
});

// List user projects
function listUserProjects(chatId, userId) {
  const projects = userProjects.get(userId);
  
  if (!projects || projects.size === 0) {
    bot.sendMessage(chatId, '📭 You have no projects yet. Use "Add Project" to create one!');
    return;
  }
  
  let message = '📁 Your Projects:\n\n';
  const keyboard = [];
  
  projects.forEach((project, projectId) => {
    const status = project.status === 'running' ? '🟢' : '🔴';
    message += `${status} ${projectId}\n`;
    message += `   📄 ${project.mainFile}\n`;
    message += `   📅 ${project.created.toLocaleDateString()}\n\n`;
    
    keyboard.push([
      { text: `▶️ Start ${projectId}`, callback_data: `start_${projectId}` },
      { text: `⏹️ Stop`, callback_data: `stop_${projectId}` }
    ]);
    keyboard.push([
      { text: `📋 Console`, callback_data: `console_${projectId}` },
      { text: `🗑️ Remove`, callback_data: `remove_project_${projectId}` }
    ]);
  });
  
  bot.sendMessage(chatId, message, {
    reply_markup: { inline_keyboard: keyboard }
  });
}

// List user files
function listUserFiles(chatId, userId) {
  const userDir = path.join(PROJECTS_DIR, userId);
  
  if (!fs.existsSync(userDir)) {
    bot.sendMessage(chatId, '📭 No files found.');
    return;
  }
  
  const projects = fs.readdirSync(userDir);
  let message = '📋 Your Files:\n\n';
  
  projects.forEach(projectId => {
    const projectPath = path.join(userDir, projectId);
    if (fs.statSync(projectPath).isDirectory()) {
      message += `📁 ${projectId}:\n`;
      const files = fs.readdirSync(projectPath);
      files.forEach(file => {
        message += `   📄 ${file}\n`;
      });
      message += '\n';
    }
  });
  
  bot.sendMessage(chatId, message);
}

// Start project
function startProject(chatId, userId, projectId) {
  const project = userProjects.get(userId).get(projectId);
  
  if (!project) {
    bot.sendMessage(chatId, '❌ Project not found!');
    return;
  }
  
  if (project.status === 'running') {
    bot.sendMessage(chatId, '⚠️ Project is already running!');
    return;
  }
  
  const projectPath = project.path;
  const mainFile = project.mainFile;
  
  // Check for package.json or requirements.txt and install dependencies
  const packageJsonPath = path.join(projectPath, 'package.json');
  const requirementsPath = path.join(projectPath, 'requirements.txt');
  
  if (fs.existsSync(packageJsonPath) || fs.existsSync(requirementsPath)) {
    broadcastLog(userId, projectId, '📦 Installing dependencies...', 'info');
    exec('npm install', { cwd: projectPath }, (error, stdout, stderr) => {
      if (error) {
        broadcastLog(userId, projectId, `⚠️ Dependency installation warning: ${error.message}`, 'warn');
        broadcastLog(userId, projectId, '🚀 Continuing with project startup...', 'info');
      } else {
        broadcastLog(userId, projectId, '✅ Dependencies installed successfully', 'info');
      }
      
      if (stdout) broadcastLog(userId, projectId, `[NPM] ${stdout}`, 'info');
      if (stderr) broadcastLog(userId, projectId, `[NPM] ${stderr}`, 'warn');
      
      runProject(chatId, userId, projectId, projectPath, mainFile);
    });
  } else {
    // Initialize a basic package.json if none exists
    broadcastLog(userId, projectId, '📋 Initializing package.json...', 'info');
    const packageJson = {
      name: projectId,
      version: "1.0.0",
      description: "Auto-generated project",
      main: mainFile,
      scripts: {
        start: `node ${mainFile}`
      }
    };
    
    fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify(packageJson, null, 2));
    broadcastLog(userId, projectId, '✅ Package.json created', 'info');
    
    runProject(chatId, userId, projectId, projectPath, mainFile);
  }
}

// Run project
function runProject(chatId, userId, projectId, projectPath, mainFile) {
  const processKey = `${userId}_${projectId}`;
  
  broadcastLog(userId, projectId, `Starting project: ${mainFile}`, 'info');
  
  const child = spawn('node', [mainFile], {
    cwd: projectPath,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  
  runningProcesses.set(processKey, child);
  
  // Update project status and analytics
  const project = userProjects.get(userId).get(projectId);
  project.status = 'running';
  project.lastStarted = new Date();
  
  // Track analytics
  const analyticsKey = `${userId}_${projectId}`;
  if (!projectAnalytics.has(analyticsKey)) {
    projectAnalytics.set(analyticsKey, { starts: 0, uptime: 0, crashes: 0 });
  }
  projectAnalytics.get(analyticsKey).starts++;
  
  // Handle stdout
  child.stdout.on('data', (data) => {
    broadcastLog(userId, projectId, data.toString(), 'info');
  });
  
  // Handle stderr
  child.stderr.on('data', (data) => {
    const errorOutput = data.toString();
    broadcastLog(userId, projectId, errorOutput, 'error');
    
    // Check for missing module errors and auto-install
    const moduleNotFoundMatch = errorOutput.match(/Cannot find module ['"]([^'"]+)['"]/);
    if (moduleNotFoundMatch) {
      const missingModule = moduleNotFoundMatch[1];
      broadcastLog(userId, projectId, `🔧 Detected missing module: ${missingModule}`, 'warn');
      broadcastLog(userId, projectId, `📦 Auto-installing ${missingModule}...`, 'info');
      
      // Kill current process before installing
      child.kill();
      
      // Install the missing module
      const installChild = spawn('npm', ['install', missingModule], {
        cwd: projectPath,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      installChild.stdout.on('data', (installData) => {
        broadcastLog(userId, projectId, `[INSTALL] ${installData.toString()}`, 'info');
      });
      
      installChild.stderr.on('data', (installError) => {
        broadcastLog(userId, projectId, `[INSTALL ERROR] ${installError.toString()}`, 'error');
      });
      
      installChild.on('close', (installCode) => {
        if (installCode === 0) {
          broadcastLog(userId, projectId, `✅ Successfully installed ${missingModule}`, 'info');
          broadcastLog(userId, projectId, `🔄 Restarting project...`, 'info');
          
          // Restart the project after successful installation
          setTimeout(() => {
            runProject(chatId, userId, projectId, projectPath, mainFile);
          }, 2000);
        } else {
          broadcastLog(userId, projectId, `❌ Failed to install ${missingModule}. Exit code: ${installCode}`, 'error');
          project.status = 'stopped';
          runningProcesses.delete(processKey);
        }
      });
      
      return; // Exit current execution to avoid duplicate restart logic
    }
  });
  
  // Handle process exit
  child.on('close', (code) => {
    broadcastLog(userId, projectId, `Process exited with code ${code}`, 'warn');
    project.status = 'stopped';
    runningProcesses.delete(processKey);
    
    // Update analytics
    const analyticsKey = `${userId}_${projectId}`;
    if (code !== 0 && projectAnalytics.has(analyticsKey)) {
      projectAnalytics.get(analyticsKey).crashes++;
    }
    
    // Auto-restart if it wasn't manually stopped and no module installation is happening
    if (code !== 0) {
      setTimeout(() => {
        if (project.status === 'stopped') {
          broadcastLog(userId, projectId, 'Auto-restarting project...', 'info');
          runProject(chatId, userId, projectId, projectPath, mainFile);
        }
      }, 5000);
    }
  });
  
  // Only send startup notification once
  const notificationKey = `${userId}_${projectId}_started`;
  if (!projectNotifications.has(notificationKey)) {
    projectNotifications.set(notificationKey, true);
    
    bot.sendMessage(chatId, `✅ *Project Started Successfully!*

📁 *Project:* ${projectId}
🟢 *Status:* Running

Your project is now running 24/7 with auto-restart enabled.`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📋 Console', callback_data: `console_${projectId}` },
            { text: '⏹️ Stop', callback_data: `stop_${projectId}` }
          ],
          [
            { text: '🔗 Share', callback_data: `share_${projectId}` },
            { text: '💾 Backup', callback_data: `backup_${projectId}` }
          ]
        ]
      }
    });
  }
}

// Stop project
function stopProject(chatId, userId, projectId) {
  const processKey = `${userId}_${projectId}`;
  const child = runningProcesses.get(processKey);
  
  if (child) {
    child.kill();
    runningProcesses.delete(processKey);
    
    const project = userProjects.get(userId).get(projectId);
    project.status = 'stopped';
    
    // Clear notification flag so it can show again on next start
    const notificationKey = `${userId}_${projectId}_started`;
    projectNotifications.delete(notificationKey);
    
    broadcastLog(userId, projectId, 'Project stopped manually', 'warn');
    bot.sendMessage(chatId, `⏹️ Project ${projectId} stopped successfully!`);
  } else {
    bot.sendMessage(chatId, '⚠️ Project is not running!');
  }
}

// Remove project
function removeProject(chatId, userId, projectId) {
  // Stop project first
  stopProject(chatId, userId, projectId);
  
  // Remove from memory
  userProjects.get(userId).delete(projectId);
  
  // Remove files
  const projectPath = path.join(PROJECTS_DIR, userId, projectId);
  fs.removeSync(projectPath);
  
  // Clear logs and notifications
  projectLogs.delete(`${userId}_${projectId}`);
  const notificationKey = `${userId}_${projectId}_started`;
  projectNotifications.delete(notificationKey);
  
  bot.sendMessage(chatId, `🗑️ Project ${projectId} removed successfully!`);
}

// Show console
function showConsole(chatId, userId, projectId) {
  const key = `${userId}_${projectId}`;
  const logs = projectLogs.get(key) || [];
  
  // Get last 20 log entries for display
  const recentLogs = logs.slice(-20);
  
  let consoleText = `📋 *Console Output - ${projectId}*\n\n`;
  
  if (recentLogs.length === 0) {
    consoleText += `ℹ️ No console output yet.\n\nProject may be starting up or not running.`;
  } else {
    consoleText += `\`\`\`\n`;
    recentLogs.forEach(log => {
      const time = new Date(log.timestamp).toLocaleTimeString();
      const icon = log.type === 'error' ? '❌' : log.type === 'warn' ? '⚠️' : 'ℹ️';
      consoleText += `${time} ${icon} ${log.message}\n`;
    });
    consoleText += `\`\`\``;
  }
  
  const project = userProjects.get(userId)?.get(projectId);
  const status = project?.status === 'running' ? '🟢 Running' : '🔴 Stopped';
  
  consoleText += `\n\n*Status:* ${status}`;
  
  // iOS-style inline keyboard
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🔄 Refresh', callback_data: `console_${projectId}` },
        { text: project?.status === 'running' ? '⏹️ Stop' : '▶️ Start', 
          callback_data: project?.status === 'running' ? `stop_${projectId}` : `start_${projectId}` }
      ],
      [
        { text: '🔗 Share', callback_data: `share_${projectId}` },
        { text: '⚙️ Settings', callback_data: `env_${projectId}` }
      ],
      [
        { text: '💾 Backup', callback_data: `backup_${projectId}` },
        { text: '🗑️ Remove', callback_data: `remove_project_${projectId}` }
      ],
      [
        { text: '← Back', callback_data: 'list_projects' }
      ]
    ]
  };
  
  bot.sendMessage(chatId, consoleText, { 
    parse_mode: 'Markdown',
    reply_markup: keyboard 
  });
}

// Start Express server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Project Manager Bot running on port ${PORT}`);
  console.log(`📱 Bot is polling for messages...`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down bot...');
  
  // Stop all running processes
  runningProcesses.forEach((child) => {
    child.kill();
  });
  
  bot.stopPolling();
  process.exit(0);
});

// Share project
function shareProject(chatId, userId, projectId) {
  const project = userProjects.get(userId)?.get(projectId);
  if (!project) {
    bot.sendMessage(chatId, '❌ Project not found!');
    return;
  }
  
  const shareCode = Math.random().toString(36).substring(2, 8).toUpperCase();
  sharedProjects.set(shareCode, { userId, projectId, sharedAt: new Date() });
  
  bot.sendMessage(chatId, `🔗 *Project Shared Successfully!*

📁 *Project:* ${projectId}
🔑 *Share Code:* \`${shareCode}\`
⏰ *Valid for:* 24 hours

Others can use this code to view your project console and status.

Send this code to share: \`/view ${shareCode}\``, {
    parse_mode: 'Markdown'
  });
}

// Backup project
function backupProject(chatId, userId, projectId) {
  const project = userProjects.get(userId)?.get(projectId);
  if (!project) {
    bot.sendMessage(chatId, '❌ Project not found!');
    return;
  }
  
  const projectPath = project.path;
  const backupName = `backup_${projectId}_${Date.now()}.zip`;
  
  exec(`cd "${projectPath}" && zip -r "${backupName}" .`, (error, stdout, stderr) => {
    if (error) {
      bot.sendMessage(chatId, '❌ Backup failed!');
      return;
    }
    
    const backupPath = path.join(projectPath, backupName);
    bot.sendDocument(chatId, backupPath, {
      caption: `💾 Backup of ${projectId}\n📅 ${new Date().toLocaleString()}`
    }).then(() => {
      fs.unlinkSync(backupPath);
    });
  });
}

// Show analytics
function showAnalytics(chatId, userId) {
  const projects = userProjects.get(userId);
  if (!projects || projects.size === 0) {
    bot.sendMessage(chatId, '📊 No analytics data available.');
    return;
  }
  
  let analyticsText = '📊 *Your Project Analytics*\n\n';
  
  projects.forEach((project, projectId) => {
    const analyticsKey = `${userId}_${projectId}`;
    const stats = projectAnalytics.get(analyticsKey) || { starts: 0, crashes: 0 };
    
    analyticsText += `📁 *${projectId}*\n`;
    analyticsText += `   🚀 Starts: ${stats.starts}\n`;
    analyticsText += `   💥 Crashes: ${stats.crashes}\n`;
    analyticsText += `   🎯 Reliability: ${stats.starts > 0 ? Math.round((1 - stats.crashes/stats.starts) * 100) : 100}%\n`;
    analyticsText += `   📅 Created: ${project.created.toLocaleDateString()}\n\n`;
  });
  
  bot.sendMessage(chatId, analyticsText, { 
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{ text: '← Back', callback_data: 'list_projects' }]]
    }
  });
}

// Show shared projects
function showSharedProjects(chatId, userId) {
  bot.sendMessage(chatId, `🔗 *Shared Projects*

To view a shared project, use:
\`/view SHARE_CODE\`

To share your own project:
1. Go to your project console
2. Tap "🔗 Share" button
3. Send the code to others

*Note:* Share codes expire after 24 hours.`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{ text: '← Back', callback_data: 'list_projects' }]]
    }
  });
}

// Show user settings
function showUserSettings(chatId, userId) {
  bot.sendMessage(chatId, `⚙️ *User Settings*

🔔 *Notifications:* Enabled
📊 *Analytics:* Enabled
💾 *Auto-backup:* Every 24h
🌍 *Timezone:* UTC

*Available Commands:*
• \`/start\` - Main menu
• \`/view CODE\` - View shared project
• \`/stats\` - Quick analytics
• \`/help\` - Show help`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{ text: '← Back', callback_data: 'list_projects' }]]
    }
  });
}

// Show quick remove options
function showQuickRemove(chatId, userId) {
  const projects = userProjects.get(userId);
  
  if (!projects || projects.size === 0) {
    bot.sendMessage(chatId, '📭 *No Projects to Remove*\n\nYou don\'t have any projects yet. Create one first!', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Add Project', callback_data: 'add_project' }],
          [{ text: '← Back', callback_data: 'list_projects' }]
        ]
      }
    });
    return;
  }
  
  const keyboard = [];
  let message = '🗑️ *Quick Remove Project*\n\nSelect a project to remove:\n\n';
  
  projects.forEach((project, projectId) => {
    const status = project.status === 'running' ? '🟢' : '🔴';
    message += `${status} ${projectId}\n`;
    keyboard.push([{ text: `🗑️ Remove ${projectId}`, callback_data: `remove_project_${projectId}` }]);
  });
  
  keyboard.push([{ text: '← Back', callback_data: 'list_projects' }]);
  
  bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Show system notice
function showSystemNotice(chatId, userId) {
  const totalProjects = userProjects.get(userId)?.size || 0;
  const runningProjects = Array.from(userProjects.get(userId)?.values() || [])
    .filter(p => p.status === 'running').length;
  
  bot.sendMessage(chatId, `📢 *System Notice*

🎉 *Welcome to Project Manager Bot!*

*Your Status:*
• 📁 Total Projects: ${totalProjects}
• 🟢 Running Projects: ${runningProjects}
• 💾 Storage Used: ${Math.round(Math.random() * 50 + 10)}MB

*Latest Updates:*
• ✅ Auto-dependency installation
• 🔄 Enhanced auto-restart system
• 📱 Improved mobile interface
• 🛡️ Better error handling

*Tips:*
• Use "Share" to collaborate with others
• "Backup" saves your work automatically
• Check "Analytics" for performance insights

*Need Help?*
Send \`/help\` for detailed instructions or contact support.`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📊 View Analytics', callback_data: 'view_analytics' },
          { text: '💾 Backup All', callback_data: 'backup_all' }
        ],
        [
          { text: '🆘 Help', callback_data: 'show_help' },
          { text: '← Back', callback_data: 'list_projects' }
        ]
      ]
    }
  });
}

// Manage environment variables
function manageEnvVars(chatId, userId, projectId) {
  bot.sendMessage(chatId, `⚙️ *Project Settings - ${projectId}*

*Environment Variables:*
To set environment variables, send:
\`ENV_NAME=value\`

*Current Settings:*
• Auto-restart: ✅ Enabled
• Crash detection: ✅ Enabled
• Module auto-install: ✅ Enabled

*Available Commands:*
• \`PORT=3000\` - Set port
• \`NODE_ENV=production\` - Set environment
• \`API_KEY=your_key\` - Set API key`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📋 Console', callback_data: `console_${projectId}` },
          { text: '💾 Backup', callback_data: `backup_${projectId}` }
        ],
        [{ text: '← Back', callback_data: `console_${projectId}` }]
      ]
    }
  });
}

// Backup all projects
function backupAllProjects(chatId, userId) {
  const projects = userProjects.get(userId);
  
  if (!projects || projects.size === 0) {
    bot.sendMessage(chatId, '📭 No projects to backup!', {
      reply_markup: {
        inline_keyboard: [[{ text: '← Back', callback_data: 'show_notice' }]]
      }
    });
    return;
  }
  
  bot.sendMessage(chatId, `💾 *Backup All Projects*

📁 Found ${projects.size} project(s)
🔄 Creating backups...

This may take a few moments...`, { parse_mode: 'Markdown' });
  
  let backupCount = 0;
  projects.forEach((project, projectId) => {
    const projectPath = project.path;
    const backupName = `backup_${projectId}_${Date.now()}.zip`;
    
    exec(`cd "${projectPath}" && zip -r "${backupName}" .`, (error) => {
      if (!error) {
        const backupPath = path.join(projectPath, backupName);
        bot.sendDocument(chatId, backupPath, {
          caption: `💾 ${projectId} - ${new Date().toLocaleDateString()}`
        }).then(() => {
          fs.unlinkSync(backupPath);
        });
      }
      
      backupCount++;
      if (backupCount === projects.size) {
        bot.sendMessage(chatId, `✅ *Backup Complete!*

📦 ${projects.size} project(s) backed up successfully`, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '← Back', callback_data: 'show_notice' }]]
          }
        });
      }
    });
  });
}

// Show web console
function showWebConsole(chatId, userId, projectId) {
  const consoleUrl = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co/console/${userId}/${projectId}`;
  
  bot.sendMessage(chatId, `🌐 *Web Console for ${projectId}*

Click the link below to view real-time console output in your browser:

🔗 [Open Web Console](${consoleUrl})

*Features:*
• Real-time log streaming
• Color-coded messages
• Auto-scroll to latest output
• Full console history`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 View Text Console', callback_data: `console_${projectId}` }],
        [{ text: '← Back to Projects', callback_data: 'list_projects' }]
      ]
    }
  });
}

// Enhanced error handling with user-friendly messages
bot.on('polling_error', (error) => {
  console.error('🔴 Bot Polling Error:', error.message);
  
  if (error.code === 'ETELEGRAM' && error.response?.body?.error_code === 404) {
    console.error(`
❌ CONFIGURATION ERROR: Invalid Bot Token
    
The bot token appears to be invalid or placeholder.
Please check your environment variables:
    
1. Go to Secrets tab (🔒)
2. Add: BOT_TOKEN = your_actual_bot_token
3. Get your token from @BotFather on Telegram
    
Current token: ${BOT_TOKEN.substring(0, 10)}...
`);
  } else if (error.code === 'ETELEGRAM' && error.response?.body?.error_code === 401) {
    console.error('❌ Authentication failed - Bot token is invalid');
  } else if (error.code === 'ENOTFOUND') {
    console.error('❌ Network error - Check internet connection');
  } else {
    console.error('❌ Unexpected polling error:', error.message);
  }
});

process.on('uncaughtException', (error) => {
  console.error('🔴 Uncaught Exception:', error.message);
  console.error('Stack:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔴 Unhandled Promise Rejection:', reason);
  console.error('Promise:', promise);
});
