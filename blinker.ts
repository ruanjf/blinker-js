import * as mqtt from 'mqtt';
import axios from 'axios';
import { Subject } from 'rxjs';
import { Widget } from './widget';
import bonjour from 'bonjour';

export interface Message {
    fromDevice?: string,
    data: any
}

export class BlinkerDevice {

    serverUrl: string
    protocol: string

    mqttClient: mqtt.MqttClient;

    config: {
        broker: string,
        deviceName: string,
        host: string,
        iotId: string,
        iotToken: string,
        port: string,
        productKey: string,
        uuid: string
    };

    subtopic;
    pubtopic;

    deviceName;
    // password;

    targetDevice;

    dataRead = new Subject<Message>()

    heartbeat = new Subject<Message>()

    builtinSwitch = new BuiltinSwitch();

    widgetKeyList = []
    widgetDict = {}

    constructor(authkey, options = {
        host: 'https://iot.diandeng.tech',
        protocol: "mqtts"
    }) {
        this.serverUrl = options.host + '/api/v1/user/device/diy/auth?authKey=';
        this.protocol = options.protocol
        this.init(authkey)
    }

    init(authkey) {
        axios.get(this.serverUrl + authkey + '&protocol=' + this.protocol).then(resp => {
            console.log(resp.data);
            this.config = resp.data.detail
            if (this.config.broker == 'aliyun') {
                this.initBroker_Aliyun()
            } else if (this.config.broker == 'blinker') {
                this.initBroker_Blinker()
            }
            this.connectBroker()
            this.addWidget(this.builtinSwitch)

            // 开启mdns服务
            bonjour().publish({
                name: this.config.deviceName,
                type: 'blinker',
                host: this.config.deviceName + '.local',
                port: 81
            })
        })
    }

    initBroker_Aliyun() {
        this.subtopic = `/${this.config.productKey}/${this.config.deviceName}/r`;
        this.pubtopic = `/${this.config.productKey}/${this.config.deviceName}/s`;
        this.targetDevice = this.config.uuid;
    }

    initBroker_Blinker() {
        this.subtopic = `/device/${this.config.deviceName}/r`;
        this.pubtopic = `/device/${this.config.deviceName}/s`;
        this.targetDevice = this.config.uuid;
    }

    connectBroker() {
        this.mqttClient = mqtt.connect(this.config.host + ':' + this.config.port, {
            clientId: this.config.deviceName,
            username: this.config.iotId,
            password: this.config.iotToken
        });

        this.mqttClient.on('connect', () => {
            console.log('blinker connected');
            this.mqttClient.subscribe(this.subtopic);
        })

        this.mqttClient.on('message', (topic, message) => {
            let data;
            let fromDevice;
            try {
                fromDevice = JSON.parse(u8aToString(message)).fromDevice
                data = JSON.parse(u8aToString(message)).data
            } catch (error) {
                console.log(error);
            }
            if (typeof data['get'] != 'undefined') {
                this.heartbeat.next(data);
                this.mqttClient.publish(this.pubtopic, formatMess2Device(this.config.deviceName, fromDevice, `{"state":"online"}`))
            } else {
                let otherData = {}
                for (const key in data) {
                    // 处理组件数据
                    if (this.widgetKeyList.indexOf(key) > -1) {
                        let widget: Widget = this.widgetDict[key]
                        widget.change.next({
                            fromDevice: fromDevice,
                            data: data[key],
                        })
                    } else {
                        let temp = {};
                        temp[key] = data[key]
                        otherData = Object.assign(otherData, temp)
                    }
                }
                if (JSON.stringify(otherData) != '{}')
                    this.dataRead.next({
                        fromDevice: fromDevice,
                        data: otherData
                    })
            }
        })

        this.mqttClient.on('error', (err) => {
            console.log(err);
        })
    }

    sendTimers = {};

    messageDataCache = {}

    sendMessage(message: string | Object, toDevice = this.targetDevice) {
        let sendMessage: string;
        if (typeof message == 'object') sendMessage = JSON.stringify(message)
        else sendMessage = message
        if (isJson(sendMessage)) {
            if (typeof this.messageDataCache[toDevice] == 'undefined') this.messageDataCache[toDevice] = '';
            let ob = this.messageDataCache[toDevice] == '' ? {} : JSON.parse(this.messageDataCache[toDevice]);
            let ob2 = JSON.parse(sendMessage)
            this.messageDataCache[toDevice] = JSON.stringify(Object.assign(ob, ob2))
            if (typeof this.sendTimers[toDevice] != 'undefined') clearTimeout(this.sendTimers[toDevice]);
            //检查设备是否是本地设备,是否已连接
            // let deviceInLocal = false;
            // if (this.islocalDevice(device)) {
            //     if (this.lanDeviceList[toDevice].state == 'connected')
            //         deviceInLocal = true
            // }
            this.sendTimers[toDevice] = setTimeout(() => {
                this.mqttClient.publish(this.pubtopic, formatMess2Device(this.config.deviceName, toDevice, this.messageDataCache[toDevice]))
                this.messageDataCache[toDevice] = '';
                delete this.sendTimers[toDevice];
            }, 100)
        } else {
            console.log('not json');
            if (!isNumber(sendMessage)) sendMessage = `"${sendMessage}"`
            this.mqttClient.publish(this.pubtopic, formatMess2Device(this.config.deviceName, toDevice, sendMessage))
        }
    }

    // toDevice
    sendMessage2Device(message, toDevice = this.targetDevice) {
        this.sendMessage(message, toDevice)
    }
    // toGrounp
    sendMessage2Grounp(message, toGrounp) {

    }
    // toStorage
    storageCache = [];
    tsDataTimer;
    saveTsData(data: any) {
        if (this.config.broker != 'blinker') {
            warn('saveTsData:仅可用于blinker broker');
            return
        }
        // console.log(JSON.stringify(this.storageCache));
        clearTimeout(this.tsDataTimer);
        let currentData = Object.assign({ date: Math.floor((new Date).getTime() / 1000) }, data)
        if (this.storageCache.length == 0 || currentData.date - this.storageCache[this.storageCache.length - 1].date >= 5) {
            this.storageCache.push(currentData)
        }
        if (this.storageCache[this.storageCache.length - 1].date - this.storageCache[0].date >= 60 || this.storageCache.length >= 12) {
            this.sendTsData()
        } else
            this.tsDataTimer = setTimeout(() => {
                this.sendTsData()
            }, 60000);
    }

    sendTsData() {
        let data = JSON.stringify(this.storageCache)
        if (data.length > 10240) {
            warn('saveTsData:单次上传数据长度超过5120字节,请减少数据内容，或降低数据上传频率');
            return
        }
        this.mqttClient.publish(this.pubtopic, formatMess2Storage(this.config.deviceName, 'ts', data))
        this.storageCache = []
    }
    objectDataTimer
    saveObjectData(data: any) {
        if (this.config.broker != 'blinker') {
            warn('saveObjectData:仅可用于blinker broker')
            return
        }
        let dataCache;
        if (typeof data == 'string') {
            if (!isJson(data)) {
                warn(`saveObjectData:数据不是对象`)
                return
            } else {
                dataCache = JSON.parse(data)
            }
        } else {
            dataCache = data
        }
        clearTimeout(this.objectDataTimer);
        this.objectDataTimer = setTimeout(() => {
            this.mqttClient.publish(this.pubtopic, formatMess2Storage(this.config.deviceName, 'ot', JSON.stringify(dataCache)))
        }, 5000);
    }
    textDataTimer
    saveTextData(data: string) {
        if (this.config.broker != 'blinker') {
            warn('saveTextData:仅可用于blinker broker');
            return
        }
        if (data.length > 1024) {
            warn('saveTextData:数据长度超过1024字节');
            return
        }
        clearTimeout(this.textDataTimer);
        this.textDataTimer = setTimeout(() => {
            this.mqttClient.publish(this.pubtopic, formatMess2Storage(this.config.deviceName, 'ot', data))
        }, 5000);
    }

    addWidget(widget: Widget | any): Widget | any {
        widget.device = this;
        this.widgetKeyList.push(widget.key);
        this.widgetDict[widget.key] = widget;
        return widget
    }

    vibrate(time = 500) {
        this.sendMessage(`{"vibrate":${time}}`)
    }

}

export class BuiltinSwitch {
    key = 'switch';
    state = '';
    change = new Subject<Message>();

    setState(state) {
        this.state = state
        return this
    }

    update() {
        let message = {}
        message[this.key] = this.state
        this.device.sendMessage(message)
    }
    device: BlinkerDevice;
}

function formatMess2Device(deviceId, toDevice, data) {
    // 兼容阿里broker保留deviceType和fromDevice  
    return `{"deviceType":"OwnApp","data":${data},"fromDevice":"${deviceId}","toDevice":"${toDevice}"}`
}

function formatMess2Grounp(deviceId, toGrounp, data) {
    return `{"data":${data},"fromDevice":"${deviceId}","toGrounp":"${toGrounp}"}`
}

function formatMess2Storage(deviceId, storageType, data) {
    return `{"data":${data},"fromDevice":"${deviceId}","toStorage":"${storageType}"}`
}

function u8aToString(fileData) {
    var dataString = "";
    for (var i = 0; i < fileData.length; i++) {
        dataString += String.fromCharCode(fileData[i]);
    }
    return dataString
}

function isJson(str: string) {
    if (isNumber(str)) {
        return false;
    }
    try {
        JSON.parse(str);
        return true;
    } catch (e) {
        return false;
    }
}

function isNumber(val: string) {
    var regPos = /^\d+(\.\d+)?$/; //非负浮点数
    var regNeg = /^(-(([0-9]+\.[0-9]*[1-9][0-9]*)|([0-9]*[1-9][0-9]*\.[0-9]+)|([0-9]*[1-9][0-9]*)))$/; //负浮点数
    if (regPos.test(val) || regNeg.test(val)) {
        return true;
    } else {
        // console.log("不是数字");
        return false;
    }
}

// 辅助调试
function log(msg, { title = 'TITLE', color = 'white' } = {}) {
    const COLOR_CODE = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'].indexOf(color)
    if (COLOR_CODE >= 0) {
        const TITLE_STR = title ? `\x1b[4${COLOR_CODE};30m ${title} \x1b[0m ` : ''
        console.log(`${TITLE_STR}\x1b[3${COLOR_CODE}m${msg}\x1b[;0m`)
    }
    else {
        console.log(title ? `${title} ${msg}` : msg)
    }
}

function warn(msg) {
    log(msg, { title: 'warn', color: 'yellow' })
}