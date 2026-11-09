(function(scope){
  'use strict';
  const crops={
    guava:{id:'guava',name:'Ổi',humid_target:'thán thư và đốm thối quả ổi',
      climate_defaults:{temperature_min:25,temperature_max:30,humidity_min:85,hold_minutes:60,cooldown_minutes:360},
      climate_reference:'Tài liệu ghi nhận thán thư xuất hiện rõ trong mùa mưa, bào tử phát tán theo gió/nước. Bộ số cài đặt là sàng lọc tại trạm, chưa phải mô hình dự báo nhiễm bệnh.',
      humid_action:'Kiểm tra đốm lõm nâu/đen trên quả, thu gom quả bệnh và giữ tán thông thoáng.',
      disease_sources:[{title:'TNAU — Thán thư trên ổi',url:'https://agritech.tnau.ac.in/crop_protection/crop_protdiseases_postharvest_guava_1.html'}],
      pest_sources:[{title:'TNAU — Ngài đục quả trên ổi',url:'https://agritech.tnau.ac.in/crop_protection/guava/guava_1.html'}]},
    pomegranate:{id:'pomegranate',name:'Lựu',humid_target:'thán thư/đốm lá và quả lựu',
      climate_defaults:{temperature_min:25,temperature_max:30,humidity_min:85,hold_minutes:60,cooldown_minutes:360},
      climate_reference:'Có nghiên cứu thực địa về thán thư và đốm lá/quả trên lựu. Các ngưỡng nhiệt–ẩm/thời gian ở đây là nhắc kiểm tra vận hành, chưa định lượng xác suất bệnh.',
      humid_action:'Kiểm tra đốm trên lá/quả, thu gom quả bị đốm thối và giảm thời gian tưới ướt tán.',
      disease_sources:[{title:'ICAR — Nghiên cứu bệnh lá/quả lựu',url:'https://epubs.icar.org.in/index.php/IJAH/article/view/180031'}],
      pest_sources:[{title:'TNAU — Ngài đục quả trên lựu',url:'https://agritech.tnau.ac.in/crop_protection/pome_pest/pome_2.html'}]},
    durian:{id:'durian',name:'Sầu riêng',humid_target:'thối quả/xì mủ liên quan Phytophthora trên sầu riêng',
      climate_defaults:{temperature_min:24,temperature_max:30,humidity_min:85,hold_minutes:60,cooldown_minutes:360},
      climate_reference:'Phytophthora trên sầu riêng liên quan điều kiện ẩm/mưa. Cảm biến trạm không phát hiện tác nhân hay độ ướt quả; ngưỡng là nhắc kiểm tra, chưa phải chẩn đoán.',
      humid_action:'Kiểm tra vết thối trên quả, vết xì mủ ở thân/gốc và khả năng thoát nước; đối chiếu chuyên môn khi có triệu chứng.',
      disease_sources:[{title:'Nghiên cứu Phytophthora trên sầu riêng',url:'https://doi.org/10.1111/jph.70089'}],
      pest_sources:[{title:'Tạp chí Nông nghiệp và Môi trường — Ngài đục quả sầu riêng tại ĐBSCL',url:'https://tapchikhoahoc.nnmt.net.vn/index.php/vjae/article/view/3081'}]},
    pear:{id:'pear',name:'Lê',humid_target:'đốm nâu trên lê (tham khảo nghiên cứu lê châu Âu)',
      climate_defaults:{temperature_min:15,temperature_max:25,humidity_min:85,hold_minutes:120,cooldown_minutes:360},
      climate_reference:'Nghiên cứu lê châu Âu ghi nhận liên hệ với 15–25°C, ẩm cao và thời kỳ ướt trên 10 giờ. Trạm chưa đo ướt lá; ngưỡng 2 giờ chỉ nhắc kiểm tra và cần xác nhận giống/địa phương.',
      humid_action:'Kiểm tra đốm nâu trên lá/quả; xác nhận giống lê và triệu chứng trước khi gán tên bệnh.',
      disease_sources:[{title:'Nghiên cứu thời tiết và bệnh đốm nâu lê',url:'https://publires.unicatt.it/en/publications/patterns-of-airborne-conidia-of-stemphylium-vesicarium-the-causal-7/'}],
      pest_sources:[{title:'NZ MPI — Conogethes punctiferalis trên lê',url:'https://www.mpi.govt.nz/consultations/proposed-amendments-to-import-requirements-to-manage-the-yellow-peach-moth-conogethes-punctiferalis-on-fresh-lychee-longan-and-pear'}]},
  };
  const rules=[{
    id:'soil_wet',name:'Đất ướt kéo dài — theo dõi nguy cơ hại/thối rễ',sensor:'Đầu dò độ ẩm đất (ADC)',
    benefit:'Phát hiện đất giữ ướt lâu để kiểm tra tưới và thoát nước, trước khi có biểu hiện bất thường ở cây.',
    action:'Kiểm tra vị trí đầu dò, lịch tưới, nước đọng và rễ; chỉ thay đổi tưới sau khi kiểm tra đất thực tế.',
    limitation:'Chỉ số ướt là tương đối giữa hai mốc hiệu chuẩn, không phải phần trăm nước trong đất. Không có ngưỡng ADC chung xác nhận thối rễ.',
    sources:[{title:'UF/IFAS — Dùng cảm biến độ ẩm đất cho cây ăn quả',url:'https://ask.ifas.ufl.edu/publication/AE551'},
      {title:'UC IPM — Tưới, thoát nước và nguy cơ bệnh rễ',url:'https://ipm.ucanr.edu/agriculture/citrus/phytophthora-root-rot/'}],
  },{
    id:'humid_environment',name:'Môi trường ẩm kéo dài — theo dõi bệnh trên lá/quả',sensor:'DHT11: nhiệt độ + độ ẩm không khí',
    benefit:'Kết hợp nhiệt độ và độ ẩm trong cùng mẫu, cùng thời gian duy trì để nhắc kiểm tra theo cây đang trồng.',
    action:'Kiểm tra lá/quả và độ thông thoáng của tán, đối chiếu triệu chứng thực tế.',
    limitation:'RH là ẩm không khí, không phải độ ướt lá. Ngưỡng RH 85%/thời gian cài đặt là vận hành cảnh báo sớm, chưa phải ngưỡng xác nhận sinh bệnh. Cần hiệu chuẩn DHT11.',
    sources:[],
  },{
    id:'pest_image',name:'Sâu hại trong ảnh bẫy',sensor:'ESP32-CAM + AI',
    benefit:'Cảnh báo khi số côn trùng trong ảnh camera mới đạt ngưỡng riêng của từng loài đã chọn.',
    action:'Kiểm tra lỗ đục, phân sâu và quả hư; xác nhận sâu non tại cây.',
    limitation:'AI gợi ý sáu loài; có thể bật thêm nhóm chưa xác định. Côn trùng trong bẫy không đồng nghĩa cây đang bị hại. Ảnh mẫu/demo không tạo cảnh báo thật.',
    sources:[],
  }];
  const pests={
    Cnaphalocrocis_medinalis:{name:'Ngài sâu cuốn lá nhỏ',hosts:'Lúa',fruit:false,damage:'Sâu non cuốn lá và ăn biểu bì lá lúa.',check:'Kiểm tra lại loài trong ảnh; đây không phải bằng chứng bệnh trên cây ăn quả.',url:'https://databases.nbair.res.in/insectpests/Cnaphalocrocis-medinalis.php'},
    Plutella_xylostella:{name:'Ngài sâu tơ',hosts:'Rau họ cải',fruit:false,damage:'Sâu non ăn lá rau họ cải.',check:'Kiểm tra lại loài và cây ký chủ; không suy ra bệnh cây ăn quả.',url:'https://ipm.ucanr.edu/home-and-landscape/diamondback-moth/'},
    Ostrinia_furnacalis:{name:'Ngài sâu đục thân ngô',hosts:'Ngô',fruit:false,damage:'Sâu non gây hại lá, thân và bắp ngô.',check:'Kiểm tra lại loài và cây ký chủ; không suy ra bệnh cây ăn quả.',url:'https://gd.eppo.int/taxon/PYRUFU'},
    Scotinophara_coarctata:{name:'Bọ xít đen',hosts:'Lúa',fruit:false,damage:'Chích hút lúa, có thể làm vàng/cháy cây.',check:'Kiểm tra lại loài trong ảnh; không gán bệnh vàng lá cây ăn quả cho bọ này.',url:'https://books.irri.org/9789712203008_content.pdf'},
    Conogethes_punctiferalis:{name:'Ngài đục quả',hosts:'Ổi, lựu, sầu riêng, lê; cần xác nhận cây, giống và loài tại vườn',fruit:true,
      damage:'Sâu non có thể đục quả, ăn phần bên trong và làm quả rụng sớm.',
      related:'Vết đục có thể tạo điều kiện cho tác nhân khác xâm nhập gây thối quả thứ cấp. Chưa xác định được nấm/vi khuẩn nào và không kết luận thán thư từ ảnh ngài.',
      check:'Kiểm tra lỗ đục, phân sâu, tơ và vùng thối trên quả; thu gom quả hư, kiểm tra trực tiếp sâu non.',
      url:'https://databases.nbair.res.in/insectpests/Dichocrocis-punctiferalis.php',
      related_url:'https://www.ukdr.uplb.edu.ph/etd-grad/3346/'},
    Diaphania_indica:{name:'Ngài sâu xanh dưa',hosts:'Bầu, bí, dưa',fruit:false,damage:'Sâu non ăn lá, hoa và quả cây họ bầu bí.',check:'Kiểm tra lại loài và cây ký chủ; không coi đây là chẩn đoán bệnh cây ăn quả thân gỗ.',url:'https://databases.nbair.res.in/insectpests/Diaphania-indica.php'},
  };
  function pestAdvice(detections){
    const counts={};for(const d of detections||[])if(d.identification_status==='identified'&&pests[d.pest_code])counts[d.pest_code]=(counts[d.pest_code]||0)+1;
    return Object.entries(counts).map(([code,count])=>({code,count,...pests[code]}));
  }
  function pestAdviceText(detections){
    return pestAdvice(detections).map(p=>`${p.name} (${p.count}) · Ký chủ: ${p.hosts}\nNguy cơ gây hại: ${p.damage}\n${p.related?'Bệnh liên quan cần kiểm tra: '+p.related:'Bệnh cây ăn quả liên quan: chưa có căn cứ suy ra từ loài này.'}\nNên làm: ${p.check}`).join('\n\n');
  }
  const pestAlertSpecies={...Object.fromEntries(Object.entries(pests).map(([code,p])=>[code,p.name])),unknown:'Côn trùng chưa xác định'};
  function pestAlertThresholds(parameters={}){
    if(parameters.species_thresholds)return {...parameters.species_thresholds};
    return Object.fromEntries(Object.keys(pestAlertSpecies).map(code=>[code,code==='unknown'?null:
      code==='Conogethes_punctiferalis'?(parameters.min_identified??1):1]));
  }
  const api={profile:'Bốn hồ sơ cây: ổi, lựu, sầu riêng, lê',crops,rules,pests,pestAdvice,pestAdviceText,pestAlertSpecies,pestAlertThresholds};
  if(typeof module==='object'&&module.exports)module.exports=api;else scope.FruitHealth=api;
})(typeof globalThis==='object'?globalThis:this);
