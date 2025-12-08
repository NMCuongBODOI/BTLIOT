// ===== GLOBAL VARIABLES =====
let ws = null;
let currentMode = 'manual';
let isConnected = false;
let reconnectInterval = null;

// Connection status tracking
let hasESP32 = false;
let hasVideoStream = false;
let hasSensorData = false;
let lastVideoTime = 0;
let lastSensorTime = 0;

// Alert system
let alerts = [];
let currentAlertId = null;
let newAlertsCount = 0;
let alertAudio = null;

// ===== WEBSOCKET CONNECTION =====
function connectWebSocket() {
    const wsUrl = 'ws://' + window.location.hostname + ':3000';
    
    console.log('🔌 Connecting to WebSocket:', wsUrl);
    addLog('Đang kết nối đến server...');
    
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'blob';
    ws.onopen = () => {
        console.log('✅ WebSocket connected!');
        isConnected = true;
        updateConnectionStatus(true);
        addLog('Kết nối thành công!');
        showToast('Đã kết nối đến xe giám sát', 'success');
        
        // Gửi tin nhắn đăng ký là user client
        ws.send(JSON.stringify({
            type: 'register',
            role: 'user'
        }));
        
        // Clear reconnect interval if exists
        if (reconnectInterval) {
            clearInterval(reconnectInterval);
            reconnectInterval = null;
        }
    };
    
    ws.onmessage = (event) => {
        // Nếu là Binary (video frame từ ESP32-CAM)
        if (event.data instanceof Blob) {
            const videoStream = document.getElementById('videoStream');
            if (videoStream) {
                // Giải phóng blob URL cũ để tránh memory leak
                if (videoStream.src && videoStream.src.startsWith('blob:')) {
                    URL.revokeObjectURL(videoStream.src);
                }
                
                // Tạo blob URL mới và hiển thị
                const url = URL.createObjectURL(event.data);
                videoStream.src = url;
                videoStream.onload = () => {
                    URL.revokeObjectURL(url); // Cleanup sau khi load
                };
                
                const noSignal = document.getElementById('noSignal');
                if (noSignal) noSignal.style.display = 'none';
                
                hasVideoStream = true;
                lastVideoTime = Date.now();
                console.log('📸 Frame received from ESP32-CAM');
            }
            return;
        }
        
        // Nếu là JSON data
        try {
            const data = JSON.parse(event.data);
            console.log('📨 Received WebSocket message:', data.type, data);
            handleServerMessage(data);
        } catch (error) {
            console.error('Lỗi xử lý dữ liệu:', error);
        }
    };
    
    ws.onerror = (error) => {
        console.error('❌ WebSocket error:', error);
        addLog('Lỗi kết nối WebSocket');
    };
    
    ws.onclose = () => {
        console.log('🔴 WebSocket closed');
        isConnected = false;
        updateConnectionStatus(false);
        addLog('Mất kết nối! Đang thử kết nối lại...');
        
        const noSignal = document.getElementById('noSignal');
        if (noSignal) noSignal.style.display = 'flex';
        
        // Auto reconnect
        if (!reconnectInterval) {
            reconnectInterval = setInterval(() => {
                addLog('Thử kết nối lại...');
                connectWebSocket();
            }, 5000);
        }
    };
}

// ===== HANDLE SERVER MESSAGES =====
function handleServerMessage(data) {
    console.log('🔄 Handling message type:', data.type);
    switch(data.type) {
        case 'sensor':
            // iottesy format: {type: 'sensor', distance: 123}
            updateSensorData(data);
            break;
        case 'alert':
            // AI alert từ Python qua server
            console.log('🚨 AI ALERT RECEIVED:', data);
            handleAIAlert(data);
            break;
        case 'sensor_data':
            updateSensorData(data);
            break;
        case 'ai_alert':
            console.log('🚨 AI ALERT (ai_alert type):', data);
            handleAIAlert(data);
            break;
        case 'system_info':
            updateSystemInfo(data);
            break;
        case 'command_response':
            addLog(`Phản hồi: ${data.message}`);
            break;
        case 'error':
            showToast(data.message, 'error');
            addLog(`Lỗi: ${data.message}`);
            break;
        default:
            console.log('Unknown message type:', data);
    }
}

// ===== SEND COMMAND TO ESP32 =====
function sendCommand(command, params = {}) {
    if (!isConnected || !ws || ws.readyState !== WebSocket.OPEN) {
        showToast('Chưa kết nối đến xe!', 'error');
        return;
    }
    
    // Format for iottesy server: {type: 'control', cmd: 'move', val: 'forward'}
    const message = {
        type: 'control',
        cmd: 'move',
        val: command
    };
    
    ws.send(JSON.stringify(message));
    addLog(`Lệnh: ${command}`);
}

// ===== MODE SWITCHING =====
function switchMode(mode) {
    currentMode = mode;
    
    // Update UI
    document.getElementById('manualMode').classList.remove('active');
    document.getElementById('autoMode').classList.remove('active');
    
    if (mode === 'manual') {
        document.getElementById('manualMode').classList.add('active');
        document.getElementById('manualControl').style.display = 'block';
        document.getElementById('autoControl').style.display = 'none';
    } else {
        document.getElementById('autoMode').classList.add('active');
        document.getElementById('manualControl').style.display = 'none';
        document.getElementById('autoControl').style.display = 'block';
    }
    
    // Send mode change to ESP32 (iottesy format)
    const modeVal = mode === 'auto' ? 'auto_on' : 'auto_off';
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({type: 'control', cmd: 'mode', val: modeVal}));
    }
    addLog(`Chuyển sang chế độ ${mode === 'manual' ? 'Manual' : 'Tự động'}`);
    showToast(`Chế độ ${mode === 'manual' ? 'Manual' : 'Tự động'} được kích hoạt`, 'info');
}


// ===== EMERGENCY STOP =====
function emergencyStop() {
    sendCommand('emergency_stop');
    addLog('🚨 DỪNG KHẨN CẤP!');
    showToast('Xe đã dừng khẩn cấp!', 'warning');
}

// ===== UPDATE SENSOR DATA =====
function updateSensorData(data) {
    // Mark sensor data as received
    hasSensorData = true;
    hasESP32 = true;
    lastSensorTime = Date.now();
    updateConnectionStatus(true);
    
    if (data.distance !== undefined) {
        document.getElementById('distanceValue').textContent = `${data.distance} cm`;
        
        // Change color based on distance
        const card = document.getElementById('distanceValue').closest('.sensor-card');
        if (data.distance < 20) {
            card.style.borderLeft = '4px solid #e74c3c';
        } else if (data.distance < 50) {
            card.style.borderLeft = '4px solid #f39c12';
        } else {
            card.style.borderLeft = '4px solid #27ae60';
        }
    }
    
    if (data.battery !== undefined) {
        const batteryValue = document.getElementById('batteryValue');
        batteryValue.textContent = `${data.battery}%`;
        
        // Change color based on battery level
        if (data.battery < 20) {
            batteryValue.style.color = '#e74c3c';
        } else if (data.battery < 50) {
            batteryValue.style.color = '#f39c12';
        } else {
            batteryValue.style.color = '#27ae60';
        }
    }
    
    if (data.speed !== undefined) {
        document.getElementById('currentSpeed').textContent = `${data.speed} km/h`;
    }
    
    if (data.temperature !== undefined) {
        document.getElementById('temperature').textContent = `${data.temperature}°C`;
    }
}

// ===== UPDATE SYSTEM INFO =====
function updateSystemInfo(data) {
    if (data.ip) {
        document.getElementById('esp32IP').textContent = data.ip;
    }
    if (data.wifi_signal) {
        document.getElementById('wifiSignal').textContent = `${data.wifi_signal} dBm`;
    }
    if (data.uptime) {
        document.getElementById('uptime').textContent = formatUptime(data.uptime);
    }
    if (data.firmware) {
        document.getElementById('firmware').textContent = data.firmware;
    }
}

// ===== FORMAT UPTIME =====
function formatUptime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours}h ${minutes}m ${secs}s`;
}

// ===== AI ALERT SYSTEM =====
function handleAIAlert(data) {
    console.log('🎯 handleAIAlert called with:', data);
    
    // Create alert object
    const alert = {
        id: data._id || Date.now(),
        type: data.alertType || 'climbing', // 'climbing' or 'fall'
        confidence: data.confidence || 87,
        imageUrl: data.imageUrl || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
        timestamp: data.timestamp ? new Date(data.timestamp) : new Date(),
        keypoints: data.keypoints || [],
        center: data.center || { x: 0.5, y: 0.5 }
    };
    
    console.log('✅ Alert object created:', alert);
    
    // Add to alerts array (mới nhất lên đầu)
    alerts.unshift(alert);
    if (alerts.length > 50) alerts.pop(); // Keep only last 50
    
    // Update UI immediately
    updateAlertTable();
    
    // Show popup
    showAlertPopup(alert);
    
    // Update badge
    newAlertsCount++;
    updateNotificationBadge();
    
    // Show inline alert
    const alertBox = document.getElementById('aiAlert');
    const alertText = document.getElementById('aiAlertText');
    alertText.textContent = data.message || 'Phát hiện hành vi bất thường!';
    alertBox.style.display = 'flex';
    
    addLog(`⚠️ AI Alert: ${data.message || 'Cảnh báo phát hiện'}`);
    
    // Play alert sound (beep 2 times)
    playAlertSound(2);
    
    // Auto hide after 10 seconds
    setTimeout(() => {
        alertBox.style.display = 'none';
    }, 10000);
}

function playAlertSound(times = 1) {
    if (!alertAudio) {
        alertAudio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBTGH0fPTgjMGHm7A7+OZSA0PVKjn77BdGAdAl9r0yXwrBSp+zPLaizsIGGS47OihUBELTKXh8bllHAU2jdXzzn0uBSd6ye/ekD4JFV616t6oUhELSKHf87plHQU0itLyzXwuBSl8y+/dkT8JFV616d+oUhELSKHf87llHQU1i9HyzXwtBSh7yu/dkT8KFV+16d+nUhILSKHf87hlHQU1i9HyzH0tBSh7yu/dkT8KFV+16d+nURELSKHf87hlHQU1i9HyzH0tBSh7yu/dkT8KFV+16d+nURELSKHf87hlHQU1i9HyzH0tBSh7yu/dkT8KFV+16d+nURELSKHf87hlHQU1i9HyzH0tBSh7yu/dkT8KFV+16d+nURELSKHf87hlHQU1i9HyzH0tBSh7yu/dkT8KFV+16d+nURELSKHf87hlHQU1i9HyzH0tBSh7yu/dkT8KFV+16d+nURELSKHf87hlHQU1i9HyzH0tBSh7yu/dkT8KFV+16d+nUREL');
    }
    
    let count = 0;
    const playBeep = () => {
        if (count < times) {
            alertAudio.play().catch(e => console.log('Audio play failed'));
            count++;
            setTimeout(playBeep, 300);
        }
    };
    playBeep();
}

// ===== ALERT POPUP =====
function showAlertPopup(alert) {
    const popup = document.getElementById('alertPopup');
    const title = document.getElementById('alertPopupTitle');
    const image = document.getElementById('alertPopupImage');
    const time = document.getElementById('alertPopupTime');
    const confidence = document.getElementById('alertPopupConfidence');
    
    // Set content
    title.textContent = alert.type === 'climbing' 
        ? 'PHÁT HIỆN NGƯỜI VƯỢT RÀO!' 
        : 'PHÁT HIỆN NGƯỜI BỊ NGÃ!';
    image.src = alert.imageUrl;
    time.textContent = `Vừa xảy ra lúc ${formatTime(alert.timestamp)}`;
    confidence.textContent = `${alert.confidence}%`;
    
    currentAlertId = alert.id;
    
    // Show popup
    popup.classList.add('show');
    
    // Auto close after 5 seconds
    setTimeout(() => {
        if (popup.classList.contains('show')) {
            closeAlertPopup();
        }
    }, 5000);
}

function closeAlertPopup() {
    document.getElementById('alertPopup').classList.remove('show');
}

function viewAlertDetail() {
    const alert = alerts.find(a => a.id === currentAlertId);
    if (alert) {
        showAlertModal(alert);
    }
    closeAlertPopup();
}

// ===== ALERT MODAL =====
function showAlertModalById(alertId) {
    const alert = alerts.find(a => a.id === alertId);
    if (alert) {
        showAlertModal(alert);
    }
}

function showAlertModal(alert) {
    const modal = document.getElementById('alertModal');
    const image = document.getElementById('alertModalImage');
    const type = document.getElementById('alertModalType');
    const time = document.getElementById('alertModalTime');
    const confidence = document.getElementById('alertModalConfidence');
    const center = document.getElementById('alertModalCenter');
    const keypointsBody = document.getElementById('keypointsTableBody');
    
    // Set content
    image.src = alert.imageUrl;
    type.textContent = alert.type === 'climbing' ? 'Vượt rào' : 'Bị ngã';
    type.className = `badge ${alert.type}`;
    time.textContent = formatDateTime(alert.timestamp);
    confidence.textContent = `${alert.confidence.toFixed(1)}%`;
    center.textContent = `(x: ${alert.center.x.toFixed(2)}, y: ${alert.center.y.toFixed(2)})`;
    
    // Populate keypoints
    keypointsBody.innerHTML = '';
    const keypointNames = [
        'Nose', 'Left Eye', 'Right Eye', 'Left Ear', 'Right Ear',
        'Left Shoulder', 'Right Shoulder', 'Left Elbow', 'Right Elbow',
        'Left Wrist', 'Right Wrist', 'Left Hip', 'Right Hip',
        'Left Knee', 'Right Knee', 'Left Ankle', 'Right Ankle'
    ];
    
    if (alert.keypoints.length > 0) {
        alert.keypoints.forEach((kp, index) => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${index + 1}</td>
                <td>${keypointNames[index] || `Point ${index + 1}`}</td>
                <td>${kp.x.toFixed(3)}</td>
                <td>${kp.y.toFixed(3)}</td>
                <td>${(kp.score * 100).toFixed(1)}%</td>
            `;
            keypointsBody.appendChild(row);
        });
    } else {
        keypointsBody.innerHTML = '<tr><td colspan="5" style="text-align: center;">Không có dữ liệu keypoints</td></tr>';
    }
    
    currentAlertId = alert.id;
    modal.classList.add('show');
}

function closeAlertModal() {
    document.getElementById('alertModal').classList.remove('show');
    document.getElementById('keypointsTable').style.display = 'none';
    document.getElementById('keypointsChevron').style.transform = 'rotate(0deg)';
}

function toggleKeypoints() {
    const table = document.getElementById('keypointsTable');
    const chevron = document.getElementById('keypointsChevron');
    
    if (table.style.display === 'none') {
        table.style.display = 'block';
        chevron.style.transform = 'rotate(180deg)';
    } else {
        table.style.display = 'none';
        chevron.style.transform = 'rotate(0deg)';
    }
}

function downloadAlertImage() {
    const alert = alerts.find(a => a.id === currentAlertId);
    if (!alert) return;
    
    const link = document.createElement('a');
    link.href = alert.imageUrl;
    link.download = `alert_${formatDateTimeFile(alert.timestamp)}.jpg`;
    link.click();
    
    showToast('Đã tải ảnh xuống', 'success');
}

// ===== ALERT TABLE =====
function updateAlertTable() {
    const tbody = document.getElementById('alertTableBody');
    
    if (!tbody) {
        console.warn('Alert table body not found!');
        return;
    }
    
    console.log('Updating alert table with', alerts.length, 'alerts');
    
    if (alerts.length === 0) {
        tbody.innerHTML = `
            <tr class="no-data">
                <td colspan="5">
                    <i class="fas fa-inbox"></i>
                    <p>Chưa có cảnh báo nào</p>
                </td>
            </tr>
        `;
        return;
    }
    
    tbody.innerHTML = '';
    
    alerts.forEach(alert => {
        const row = document.createElement('tr');
        const alertTime = new Date(alert.timestamp);
        
        // Xác định loại sự kiện hiển thị
        let eventLabel = 'Bất thường';
        if (alert.type === 'climbing') {
            eventLabel = 'Vượt rào';
        } else if (alert.type === 'fall') {
            eventLabel = 'Bị ngã';
        } else if (alert.type === 'suspicious') {
            eventLabel = 'Hành vi khả nghi';
        }
        
        row.innerHTML = `
            <td>${formatDateTime(alertTime)}</td>
            <td><span class="badge ${alert.type}">${eventLabel}</span></td>
            <td>${alert.confidence}%</td>
            <td><img src="${alert.imageUrl}" class="alert-thumbnail" onclick="showAlertModalById('${alert.id}')"></td>
            <td class="alert-actions">
                <button class="btn-icon" onclick="showAlertModalById('${alert.id}')">
                    <i class="fas fa-eye"></i> Xem
                </button>
                <button class="btn-icon delete" onclick="deleteAlert('${alert.id}')">
                    <i class="fas fa-trash"></i> Xóa
                </button>
            </td>
        `;
        tbody.appendChild(row);
    });
}

function filterAlerts() {
    const filter = document.getElementById('alertFilter').value;
    const tbody = document.getElementById('alertTableBody');
    
    const filteredAlerts = filter === 'all' 
        ? alerts 
        : alerts.filter(a => a.type === filter);
    
    if (filteredAlerts.length === 0) {
        tbody.innerHTML = `
            <tr class="no-data">
                <td colspan="5">
                    <i class="fas fa-inbox"></i>
                    <p>Không có cảnh báo phù hợp</p>
                </td>
            </tr>
        `;
        return;
    }
    
    tbody.innerHTML = '';
    filteredAlerts.forEach(alert => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${formatDateTime(alert.timestamp)}</td>
            <td><span class="badge ${alert.type}">${alert.type === 'climbing' ? 'Vượt rào' : 'Bị ngã'}</span></td>
            <td>${alert.confidence}%</td>
            <td><img src="${alert.imageUrl}" class="alert-thumbnail" onclick="showAlertModalById('${alert.id}')"></td>
            <td class="alert-actions">
                <button class="btn-icon" onclick="showAlertModalById('${alert.id}')">
                    <i class="fas fa-eye"></i> Xem
                </button>
                <button class="btn-icon delete" onclick="deleteAlert('${alert.id}')">
                    <i class="fas fa-trash"></i> Xóa
                </button>
            </td>
        `;
        tbody.appendChild(row);
    });
}

function refreshAlerts() {
    loadAlertsFromDB(currentPage); // Reload từ database
    showToast('Đã làm mới dữ liệu', 'success');
}

function deleteAlert(alertId) {
    if (confirm('Bạn có chắc chắn muốn xóa cảnh báo này?')) {
        alerts = alerts.filter(a => a.id !== alertId);
        updateAlertTable();
        showToast('Đã xóa cảnh báo', 'success');
    }
}

// ===== NOTIFICATION BADGE =====
function updateNotificationBadge() {
    const badge = document.getElementById('notificationBadge');
    const count = document.getElementById('badgeCount');
    
    count.textContent = newAlertsCount;
    
    if (newAlertsCount > 0) {
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
    }
}

function scrollToAlerts() {
    document.querySelector('.alert-history-section').scrollIntoView({ 
        behavior: 'smooth' 
    });
    newAlertsCount = 0;
    updateNotificationBadge();
}

// ===== TOAST NOTIFICATION =====
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    const toastMessage = document.getElementById('toastMessage');
    const icon = toast.querySelector('i');
    
    toastMessage.textContent = message;
    
    // Set icon and color based on type
    switch(type) {
        case 'success':
            icon.className = 'fas fa-check-circle';
            toast.style.background = '#27ae60';
            break;
        case 'error':
            icon.className = 'fas fa-times-circle';
            toast.style.background = '#e74c3c';
            break;
        case 'warning':
            icon.className = 'fas fa-exclamation-triangle';
            toast.style.background = '#f39c12';
            break;
        default:
            icon.className = 'fas fa-info-circle';
            toast.style.background = '#3498db';
    }
    
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// ===== OTA FIRMWARE UPDATE =====
const firmwareFileInput = document.getElementById('firmwareFile');
if (firmwareFileInput) {
    firmwareFileInput.addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (file) {
            document.getElementById('uploadBtn').disabled = false;
            addLog(`Đã chọn file: ${file.name}`);
        }
    });
}

function uploadFirmware() {
    const fileInput = document.getElementById('firmwareFile');
    const file = fileInput.files[0];
    
    if (!file) {
        showToast('Vui lòng chọn file firmware', 'error');
        return;
    }
    
    if (!file.name.endsWith('.bin')) {
        showToast('File phải có định dạng .bin', 'error');
        return;
    }
    
    const progressContainer = document.getElementById('uploadProgress');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    
    progressContainer.style.display = 'block';
    document.getElementById('uploadBtn').disabled = true;
    
    addLog('Bắt đầu tải firmware lên...');
    
    // Simulate upload progress (replace with actual upload logic)
    let progress = 0;
    const interval = setInterval(() => {
        progress += 5;
        progressFill.style.width = `${progress}%`;
        progressText.textContent = `${progress}%`;
        
        if (progress >= 100) {
            clearInterval(interval);
            addLog('✓ Tải firmware thành công!');
            showToast('Firmware đã được cập nhật', 'success');
            
            setTimeout(() => {
                progressContainer.style.display = 'none';
                progressFill.style.width = '0%';
                progressText.textContent = '0%';
                document.getElementById('uploadBtn').disabled = false;
                fileInput.value = '';
            }, 2000);
        }
    }, 200);
    
    // TODO: Implement actual OTA upload via HTTP POST to ESP32
    // Use fetch() or XMLHttpRequest to upload file to ESP32's OTA endpoint
}

// ===== KEYBOARD CONTROLS =====
document.addEventListener('keydown', (e) => {
    if (currentMode !== 'manual') return;
    
    switch(e.key) {
        case 'ArrowUp':
        case 'w':
        case 'W':
            sendCommand('forward');
            break;
        case 'ArrowDown':
        case 's':
        case 'S':
            sendCommand('backward');
            break;
        case 'ArrowLeft':
        case 'a':
        case 'A':
            sendCommand('left');
            break;
        case 'ArrowRight':
        case 'd':
        case 'D':
            sendCommand('right');
            break;
        case ' ':
            e.preventDefault();
            sendCommand('stop');
            break;
    }
});

document.addEventListener('keyup', (e) => {
    if (currentMode !== 'manual') return;
    
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'W', 's', 'S', 'a', 'A', 'd', 'D'].includes(e.key)) {
        sendCommand('stop');
    }
});



// ===== CONNECTION STATUS =====
function toggleStatusDetail() {
    const panel = document.getElementById('statusDetailPanel');
    if (panel) {
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    }
}

function updateConnectionStatus(connected) {
    const browserStatus = document.getElementById('browserServerStatus');
    const esp32Status = document.getElementById('serverEsp32Status');
    const videoStream = document.getElementById('videoStreamStatus');
    const sensorData = document.getElementById('sensorDataStatus');
    
    // Browser ⟷ Server connection
    if (connected) {
        browserStatus.innerHTML = '<i class="fas fa-circle"></i> Đã kết nối';
        browserStatus.className = 'status-badge connected';
    } else {
        browserStatus.innerHTML = '<i class="fas fa-circle"></i> Mất kết nối';
        browserStatus.className = 'status-badge disconnected';
    }
    
    // Server ⟷ ESP32-CAM connection
    if (hasESP32) {
        esp32Status.innerHTML = '<i class="fas fa-circle"></i> Đã kết nối';
        esp32Status.className = 'status-badge connected';
    } else {
        esp32Status.innerHTML = '<i class="fas fa-circle"></i> Chưa kết nối';
        esp32Status.className = 'status-badge disconnected';
    }
    
    // Video Stream
    if (hasVideoStream) {
        videoStream.innerHTML = '<i class="fas fa-circle"></i> Đang nhận';
        videoStream.className = 'status-badge connected';
    } else {
        videoStream.innerHTML = '<i class="fas fa-circle"></i> Không có tín hiệu';
        videoStream.className = 'status-badge disconnected';
    }
    
    // Sensor Data
    if (hasSensorData) {
        sensorData.innerHTML = '<i class="fas fa-circle"></i> Đang nhận';
        sensorData.className = 'status-badge connected';
    } else {
        sensorData.innerHTML = '<i class="fas fa-circle"></i> Không có dữ liệu';
        sensorData.className = 'status-badge disconnected';
    }
}

// ===== ACTIVITY LOG =====
function addLog(message) {
    const logContainer = document.getElementById('activityLog');
    if (!logContainer) return;
    
    const entry = document.createElement('div');
    entry.className = 'log-entry fade-in';
    
    const now = new Date();
    const time = now.toLocaleTimeString('vi-VN');
    
    entry.innerHTML = `
        <span class="log-time">${time}</span>
        <span class="log-message">${message}</span>
    `;
    
    logContainer.insertBefore(entry, logContainer.firstChild);
    
    // Keep only last 50 entries
    while (logContainer.children.length > 50) {
        logContainer.removeChild(logContainer.lastChild);
    }
}

function clearLog() {
    const logContainer = document.getElementById('activityLog');
    logContainer.innerHTML = '';
    addLog('Nhật ký đã được xóa');
}

// ===== TOAST NOTIFICATION =====
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    const toastMessage = document.getElementById('toastMessage');
    const icon = toast.querySelector('i');
    
    toastMessage.textContent = message;
    
    // Set icon and color based on type
    switch(type) {
        case 'success':
            icon.className = 'fas fa-check-circle';
            toast.style.background = '#27ae60';
            break;
        case 'error':
            icon.className = 'fas fa-times-circle';
            toast.style.background = '#e74c3c';
            break;
        case 'warning':
            icon.className = 'fas fa-exclamation-triangle';
            toast.style.background = '#f39c12';
            break;
        default:
            icon.className = 'fas fa-info-circle';
            toast.style.background = '#3498db';
    }
    
    // Show toast
    toast.classList.add('show');
    
    // Hide after 3 seconds
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// ===== HELPER FUNCTIONS =====
// ===== HELPER FUNCTIONS =====
function formatTime(date) {
    const d = new Date(date);
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

function formatDateTime(date) {
    const d = new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds} ${day}/${month}/${year}`;
}

function formatDateTimeFile(date) {
    return new Date(date).toISOString().replace(/[:.]/g, '-');
}

// ===== NOTIFICATION BADGE =====
function updateNotificationBadge() {
    const badge = document.getElementById('notificationBadge');
    const count = document.getElementById('badgeCount');
    
    count.textContent = newAlertsCount;
    
    if (newAlertsCount > 0) {
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
    }
}

function scrollToAlerts() {
    document.querySelector('.alert-history-section').scrollIntoView({ 
        behavior: 'smooth' 
    });
    newAlertsCount = 0;
    updateNotificationBadge();
}

// ===== LOAD ALERTS FROM DATABASE =====
let currentPage = 1;
let totalPages = 1;

async function loadAlertsFromDB(page = 1) {
    try {
        const token = localStorage.getItem('token');
        const response = await fetch(`/api/alerts?page=${page}&limit=10`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        const data = await response.json();
        
        if (data.success && data.alerts && data.alerts.length > 0) {
            alerts = data.alerts.map(alert => ({
                id: alert._id,
                type: alert.type,
                confidence: alert.confidence,
                imageUrl: alert.imageUrl,
                timestamp: new Date(alert.timestamp),
                keypoints: alert.keypoints,
                center: alert.center
            }));
            
            currentPage = data.pagination.page;
            totalPages = data.pagination.pages;
            
            updateAlertTable();
            updatePagination();
            console.log(`✅ Loaded ${alerts.length} alerts (Page ${currentPage}/${totalPages})`);
        } else {
            alerts = [];
            currentPage = 1;
            totalPages = 1;
            updateAlertTable();
            updatePagination();
            console.log('ℹ️ Không có cảnh báo nào');
        }
    } catch (error) {
        console.error('Error loading alerts:', error);
        alerts = [];
        currentPage = 1;
        totalPages = 1;
        updateAlertTable();
        updatePagination();
    }
}

function updatePagination() {
    const tableContainer = document.querySelector('.alert-history-section');
    let paginationDiv = document.getElementById('alertPagination');
    if (!paginationDiv) {
        paginationDiv = document.createElement('div');
        paginationDiv.id = 'alertPagination';
        tableContainer.appendChild(paginationDiv);
    }
    
    if (totalPages <= 1) {
        paginationDiv.innerHTML = '';
        return;
    }
    
    const paginationHTML = `
        <div style="text-align: center; margin-top: 20px;">
            <button onclick="loadAlertsFromDB(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''} style="padding: 8px 16px; margin: 0 5px; cursor: ${currentPage <= 1 ? 'not-allowed' : 'pointer'};">
                ← Trang trước
            </button>
            <span style="margin: 0 15px; font-weight: bold;">Trang ${currentPage} / ${totalPages}</span>
            <button onclick="loadAlertsFromDB(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''} style="padding: 8px 16px; margin: 0 5px; cursor: ${currentPage >= totalPages ? 'not-allowed' : 'pointer'};">
                Trang sau →
            </button>
        </div>
    `;
    
    paginationDiv.innerHTML = paginationHTML;
}

// ===== INITIALIZE ON PAGE LOAD =====
window.addEventListener('load', () => {
    addLog('Hệ thống đã sẵn sàng');
    
    // Video từ ESP32-CAM qua WebSocket (binary frames)
    // Không dùng HTTP stream nữa - nhận binary từ WebSocket message handler
    
    connectWebSocket();
    loadAlertsFromDB();  // Load existing alerts from database
    
    // Request sensor data periodically
    setInterval(() => {
        if (isConnected) {
            sendCommand('get_sensor_data');
        }
    }, 2000);
    
    // Request system info periodically
    setInterval(() => {
        if (isConnected) {
            sendCommand('get_system_info');
        }
    }, 5000);
    
    // Check video stream status từ ESP32-CAM (binary WebSocket)
    setInterval(() => {
        const videoStream = document.getElementById('videoStream');
        if (videoStream && videoStream.src && videoStream.src.startsWith('blob:')) {
            // Nếu có blob URL từ ESP32
            if (!hasVideoStream) {
                hasVideoStream = true;
                lastVideoTime = Date.now();
                updateConnectionStatus(isConnected);
                console.log('✅ ESP32-CAM video connected');
            }
            lastVideoTime = Date.now();
        }
    }, 1000);
    
    // Check connection timeout (10 seconds - cho ESP32 khởi động)
    setInterval(() => {
        const now = Date.now();
        
        // Video stream timeout (chỉ check nếu đã từng có video)
        if (hasVideoStream && lastVideoTime > 0 && now - lastVideoTime > 10000) {
            hasVideoStream = false;
            updateConnectionStatus(isConnected);
            console.log('⚠️ ESP32-CAM video timeout');
        }
        
        // Sensor data timeout
        if (hasSensorData && now - lastSensorTime > 5000) {
            hasSensorData = false;
            updateConnectionStatus(isConnected);
        }
        
        // ESP32 connection check (không báo lỗi nếu chưa từng kết nối)
        if (hasVideoStream || hasSensorData) {
            hasESP32 = true;
        }
    }, 1000);
});

// ===== PREVENT PAGE UNLOAD WARNING =====
window.addEventListener('beforeunload', (e) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
    }
});
